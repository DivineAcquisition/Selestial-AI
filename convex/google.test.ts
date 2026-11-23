/**
 * @vitest-environment edge-runtime
 *
 * Google for a company: connecting (with partial consent, reconnecting and a different account), what
 * the Owner authorizes, tenant isolation, disconnecting, leads, reviews, calendar changes and the job
 * worker's recovery. Every Google call goes to a fake; nothing reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, refusal, start, type T } from "../tests/harness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { conversionEligibility, parseLeadForm } from "./googleAds";
import { enabledFeatures, SCOPE } from "./lib/google/features";
import { GoogleError, googleCall, NOT_RUN_ON_TEST, writesToGoogle } from "./lib/google/http";
import { backoff } from "./lib/google/jobs";
import { gmailScopes } from "./lib/recruiter/gmail";
import { hashToken } from "./lib/recruiter/secrets";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const ENV = { GOOGLE_CLIENT_ID: "client-id.apps.test", GOOGLE_CLIENT_SECRET: "client-secret-not-real", MAILBOX_TOKEN_KEY: KEY, CONVEX_SITE_URL: "https://deployment.convex.site.test", APP_ORIGIN: "https://app.selestial.test" };

const b64url = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = (sub: string, email: string) => `${b64url({ alg: "none" })}.${b64url({ sub, email })}.sig`;

type Reply = { status?: number; body: unknown };
/** A fake Google: routes by URL substring, records every call, never touches the network. */
function fakeGoogleApi(routes: Record<string, (init: RequestInit | undefined, url: string) => Reply>) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    const match = Object.keys(routes).find((part) => url.includes(part));
    if (!match) return new Response(JSON.stringify({ error: "not faked" }), { status: 404 });
    const reply = routes[match](init, url);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls };
}

async function connect(t: T, as: ReturnType<T["withIdentity"]>, companyId: Id<"companies">, input: { feature: "drive" | "calendar" | "business_profile" | "ads" | "conversions"; grant: string[]; sub?: string; email?: string; refresh?: string | null; differentAccount?: boolean }) {
  const { url } = await as.mutation(api.google.startConnect, { companyId, feature: input.feature, differentAccount: input.differentAccount });
  const state = new URL(url).searchParams.get("state")!;
  fakeGoogleApi({
    "oauth2.googleapis.com/token": () => ({ body: { access_token: "access-1", ...(input.refresh === null ? {} : { refresh_token: input.refresh ?? "refresh-secret-1" }), scope: [SCOPE.openid, SCOPE.email, ...input.grant].join(" "), expires_in: 3600, id_token: idToken(input.sub ?? "google-sub-1", input.email ?? "owner@alpha.test") } }),
  });
  const response = await t.fetch(`/oauth/google/callback?state=${encodeURIComponent(state)}&code=auth-code`, { method: "GET" });
  return { url, state, response, location: response.headers.get("location") ?? "" };
}

describe("connecting Google", () => {
  let t: T;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    t = start();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("says plainly that Google is not available yet when setup is missing, naming no settings, and connects nothing", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    const { as, companyId } = await company(t, "owner", "Alpha");
    expect(await refusal(as.mutation(api.google.startConnect, { companyId, feature: "drive" }))).toMatch(/isn’t available yet/);
    vi.stubEnv("GOOGLE_CLIENT_ID", ENV.GOOGLE_CLIENT_ID);
    vi.stubEnv("MAILBOX_TOKEN_KEY", "");
    expect(await refusal(as.mutation(api.google.startConnect, { companyId, feature: "drive" }))).toMatch(/isn’t available yet/);
    expect((await as.query(api.google.status, { companyId })).tools.every((tool) => tool.connection === null)).toBe(true);
  });

  it("asks only for the one tool being connected, with offline access", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const { url } = await as.mutation(api.google.startConnect, { companyId, feature: "calendar" });
    const params = new URL(url).searchParams;
    expect(params.get("redirect_uri")).toBe("https://deployment.convex.site.test/oauth/google/callback");
    expect(params.get("access_type")).toBe("offline");
    // Each tool's grant stands alone.
    expect(params.get("include_granted_scopes")).toBe("false");
    expect(params.get("scope")).toContain(SCOPE.calendarEvents);
    expect(params.get("scope")).not.toContain("drive");
    expect(params.get("scope")).not.toContain("adwords");
  });

  it("only an Owner connects, chooses resources or disconnects", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const manager = await addMember(t, as, companyId, "manager", "manager");
    expect(await refusal(manager.mutation(api.google.startConnect, { companyId, feature: "drive" }))).toMatch(/not allowed|owner/i);
    await connect(t, as, companyId, { feature: "drive", grant: [SCOPE.driveFile] });
    expect(await refusal(manager.mutation(api.google.addResource, { companyId, kind: "drive_output", externalId: "folder-1", label: "Photos" }))).toMatch(/not allowed|owner/i);
    expect(await refusal(manager.mutation(api.google.disconnect, { companyId, feature: "drive" }))).toMatch(/not allowed|owner/i);
    // Anyone in the company sees what is connected.
    const seen = await manager.query(api.google.status, { companyId });
    expect(seen.tools.find((tool) => tool.feature === "drive")?.connection?.email).toBe("owner@alpha.test");
    expect(seen.canManage).toBe(false);
  });

  it("sends the Owner back to the Selestial address they started from, and never to another site", async () => {
    vi.stubEnv("APP_ORIGIN", "");
    const { as, companyId } = await company(t, "owner", "Alpha");
    const started = async (returnTo: string) => {
      const { url } = await as.mutation(api.google.startConnect, { companyId, feature: "drive", returnTo });
      const state = new URL(url).searchParams.get("state")!;
      const response = await t.fetch(`/oauth/google/callback?state=${encodeURIComponent(state)}&error=access_denied`, { method: "GET" });
      return response.headers.get("location");
    };
    expect(await started("https://selestial.io")).toBe("https://selestial.io/app/settings/integrations?tool=drive&result=declined");
    expect(await started("https://selestial-ai-git-x-divine-acquisition.vercel.app")).toMatch(/^https:\/\/selestial-ai-git-x-divine-acquisition\.vercel\.app\/app\/settings\/integrations/);
    expect(await started("https://evil.example.test")).toBe("/app/settings/integrations?tool=drive&result=declined");
    expect(await started("http://selestial.io")).toBe("/app/settings/integrations?tool=drive&result=declined");
  });

  it("keeps partial consent as partial, seals the token, and uses each state once", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    // Calendar needs three scopes; Google granted one.
    const first = await connect(t, as, companyId, { feature: "calendar", grant: [SCOPE.calendarEvents] });
    expect(first.response.status).toBe(302);
    expect(first.location).toBe("https://app.selestial.test/app/settings/integrations?tool=calendar&result=partial%3Acalendar");
    const calendar = (await as.query(api.google.status, { companyId })).tools.find((tool) => tool.feature === "calendar")!;
    expect(calendar.granted).toBe(false);
    expect(calendar.missing).toEqual(expect.arrayContaining([SCOPE.calendarList, SCOPE.calendarFreeBusy]));
    const stored = await t.run((ctx) => ctx.db.query("googleCredentials").collect());
    expect(stored).toHaveLength(1);
    expect(stored[0].sealedRefreshToken).not.toContain("refresh-secret-1");
    // The same state again is refused.
    const again = await t.fetch(`/oauth/google/callback?state=${encodeURIComponent(first.state)}&code=auth-code`, { method: "GET" });
    expect(again.headers.get("location")).toContain("result=expired");
  });

  it("connects each tool on its own, with its own Google account, and changes one tool without touching another", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connect(t, as, companyId, { feature: "drive", grant: [SCOPE.driveFile] });
    await as.mutation(api.google.addResource, { companyId, kind: "drive_output", externalId: "folder-1", label: "Photos", purpose: "photos" });
    // Calendar on a different Google account than Drive.
    const calendar = await connect(t, as, companyId, { feature: "calendar", grant: [SCOPE.calendarList, SCOPE.calendarEvents, SCOPE.calendarFreeBusy], sub: "sub-calendar", email: "scheduling@alpha.test" });
    expect(calendar.location).toContain("result=connected");
    let tools = (await as.query(api.google.status, { companyId })).tools;
    expect(tools.filter((tool) => tool.granted).map((tool) => [tool.feature, tool.connection?.email])).toEqual([["drive", "owner@alpha.test"], ["calendar", "scheduling@alpha.test"]]);
    // Each tool can only use its own grant: a Drive token cannot do Calendar.
    expect(await t.run((ctx) => ctx.db.query("googleCredentials").collect())).toHaveLength(2);
    // Reconnecting Drive with another account is refused unless the Owner chose a different account.
    const wrong = await connect(t, as, companyId, { feature: "drive", grant: [SCOPE.driveFile], sub: "someone-else", email: "other@alpha.test" });
    expect(wrong.location).toContain("result=different_account");
    const replaced = await connect(t, as, companyId, { feature: "drive", grant: [SCOPE.driveFile], sub: "someone-else", email: "other@alpha.test", differentAccount: true });
    expect(replaced.location).toContain("result=connected");
    tools = (await as.query(api.google.status, { companyId })).tools;
    expect(tools.find((tool) => tool.feature === "drive")?.connection?.email).toBe("other@alpha.test");
    // Drive's old resources do not carry over; Calendar is untouched.
    expect(tools.find((tool) => tool.feature === "drive")?.resources).toEqual([]);
    expect(tools.find((tool) => tool.feature === "calendar")?.connection?.email).toBe("scheduling@alpha.test");
    // Disconnecting Calendar leaves Drive running.
    await as.mutation(api.google.disconnect, { companyId, feature: "calendar" });
    tools = (await as.query(api.google.status, { companyId })).tools;
    expect(tools.find((tool) => tool.feature === "calendar")?.connection).toBeNull();
    expect(tools.find((tool) => tool.feature === "drive")?.granted).toBe(true);
  });

  it("revokes at Google only when no other connected tool uses the same Google account", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connect(t, as, companyId, { feature: "drive", grant: [SCOPE.driveFile] });
    await connect(t, as, companyId, { feature: "business_profile", grant: [SCOPE.business] });
    expect(await as.mutation(api.google.disconnect, { companyId, feature: "drive" })).toMatchObject({ revokedAtGoogle: false });
    expect((await as.query(api.google.status, { companyId })).tools.find((tool) => tool.feature === "business_profile")?.granted).toBe(true);
    expect(await as.mutation(api.google.disconnect, { companyId, feature: "business_profile" })).toMatchObject({ revokedAtGoogle: true });
  });

  it("refuses a resource for a feature that was not granted, and checks access with Google before calling it verified", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connect(t, as, companyId, { feature: "drive", grant: [SCOPE.driveFile] });
    expect(await refusal(as.mutation(api.google.addResource, { companyId, kind: "calendar_sync", externalId: "primary", label: "Main" }))).toMatch(/Connect Google Calendar first/);
    const resourceId = await as.mutation(api.google.addResource, { companyId, kind: "drive_source", externalId: "folder-9", label: "Price sheets" });
    expect((await as.query(api.google.status, { companyId })).resources[0].access).toBe("unverified");
    fakeGoogleApi({
      "oauth2.googleapis.com/token": () => ({ body: { access_token: "access-2", scope: [SCOPE.openid, SCOPE.email, SCOPE.driveFile].join(" ") } }),
      "/files?": () => ({ body: { files: [] } }),
      "/files/folder-9": () => ({ body: { id: "folder-9", name: "Price sheets", mimeType: "application/vnd.google-apps.folder", capabilities: { canAddChildren: true } } }),
    });
    await t.action(internal.googleWork.verifyResource, { resourceId });
    const row = (await as.query(api.google.status, { companyId })).resources[0];
    expect(row.access).toBe("verified");
    // Choosing a folder does not share the files already in it.
    expect(row.accessNote).toMatch(/files already in this folder, pick them too/);
  });

  it("an expired grant marks the connection expired, and work for it stops", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connect(t, as, companyId, { feature: "drive", grant: [SCOPE.driveFile] });
    const connectionId = (await as.query(api.google.status, { companyId })).tools.find((tool) => tool.feature === "drive")!.connection!.id;
    fakeGoogleApi({ "oauth2.googleapis.com/token": () => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }) });
    const jobId = await t.run(async (ctx) => (await ctx.db.insert("googleJobs", { companyId, connectionId, kind: "sheet_export", key: "k1", status: "running", payload: "{}", attempts: 1, nextAt: 0, createdAt: 0, updatedAt: Date.now() })));
    await t.action(internal.googleWork.run, { jobId });
    const status = await as.query(api.google.status, { companyId });
    expect(status.tools.find((tool) => tool.feature === "drive")?.connection?.status).toBe("expired");
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status: "cancelled" });
  });

  it("disconnecting stops everything at once: queued work, resources, the stored authorization", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connect(t, as, companyId, { feature: "drive", grant: [SCOPE.driveFile] });
    const folder = await as.mutation(api.google.addResource, { companyId, kind: "drive_output", externalId: "folder-1", label: "Reports", purpose: "reports" });
    // Let the access check (against the fake, which has no such folder) finish, then mark it reachable.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await t.finishInProgressScheduledFunctions();
    await t.run((ctx) => ctx.db.patch(folder, { access: "verified" }));
    const queued = await as.mutation(api.googleDrive.exportSchedule, { companyId });
    await as.mutation(api.google.disconnect, { companyId, feature: "drive" });
    expect(await t.run((ctx) => ctx.db.get(queued.jobId))).toMatchObject({ status: "cancelled" });
    expect(await t.run((ctx) => ctx.db.query("googleCredentials").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("googleResources").collect())).toEqual([]);
    expect(await refusal(as.mutation(api.googleDrive.exportSchedule, { companyId }))).toMatch(/Drive.*not connected/i);
  });
});

describe("tenant isolation", () => {
  let t: T;
  beforeEach(() => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    t = start();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("one company cannot see, use or remove another company's Google resources, reviews or drafts", async () => {
    const a = await company(t, "owner-a", "Alpha");
    const b = await company(t, "owner-b", "Bravo");
    await connect(t, a.as, a.companyId, { feature: "drive", grant: [SCOPE.driveFile] });
    await connect(t, a.as, a.companyId, { feature: "business_profile", grant: [SCOPE.business] });
    const resourceId = await a.as.mutation(api.google.addResource, { companyId: a.companyId, kind: "drive_source", externalId: "folder-a", label: "A's prices" });
    const reviewId = await t.run((ctx) => ctx.db.insert("googleReviews", { companyId: a.companyId, location: "locations/1", reviewName: "accounts/1/locations/1/reviews/r1", reviewer: "Pat", stars: 5, createdAt: 0, state: "new", seenAt: 0 }));
    expect((await b.as.query(api.google.status, { companyId: b.companyId })).tools.every((tool) => tool.connection === null)).toBe(true);
    expect(await b.as.query(api.googleBusiness.reviews, { companyId: b.companyId })).toEqual([]);
    expect(await refusal(b.as.mutation(api.google.removeResource, { companyId: b.companyId, resourceId }))).toMatch(/not found/i);
    expect(await refusal(b.as.mutation(api.googleDrive.importKnowledge, { companyId: b.companyId, resourceId }))).toMatch(/not connected|Connect Google|not found/i);
    await connect(t, b.as, b.companyId, { feature: "business_profile", grant: [SCOPE.business], sub: "sub-b", email: "b@bravo.test" });
    expect(await refusal(b.as.mutation(api.googleBusiness.approveReply, { companyId: b.companyId, reviewId, text: "Thanks!" }))).toMatch(/not found/i);
    // And B cannot name A's company at all.
    expect(await refusal(b.as.query(api.google.status, { companyId: a.companyId }))).toBeTruthy();
  });
});

describe("leads from Google", () => {
  let t: T;
  beforeEach(() => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    t = start();
  });
  afterEach(() => vi.unstubAllEnvs());

  const body = (key: string, id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ lead_id: id, google_key: key, gcl_id: "gclid-1", campaign_id: 42, user_column_data: [{ column_id: "FULL_NAME", string_value: "Jamie Rivera" }, { column_id: "EMAIL", string_value: "Jamie@Example.test" }, { column_id: "PHONE_NUMBER", string_value: "+1 (512) 555-0100" }, { column_id: "POSTAL_CODE", string_value: "78701" }], ...extra });

  it("refuses anything without the company's key, takes each lead once, and matches a known customer", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const existing = await as.mutation(api.customers.create, { companyId, name: "Jamie R.", kind: "home", email: "jamie@example.test" });
    const { key, webhookUrl } = await as.mutation(api.googleAds.rotateLeadKey, { companyId });
    expect(webhookUrl).toBe("https://deployment.convex.site.test/webhooks/google/leads");
    expect((await t.fetch("/webhooks/google/leads", { method: "POST", body: body("wrong-key", "L1") })).status).toBe(403);
    expect((await t.fetch("/webhooks/google/leads", { method: "POST", body: body(key, "L1") })).status).toBe(200);
    expect((await t.fetch("/webhooks/google/leads", { method: "POST", body: body(key, "L1") })).status).toBe(200);
    const leads = await as.query(api.googleAds.leads, { companyId });
    expect(leads.leads).toHaveLength(1);
    expect(leads.leads[0].customerId).toBe(existing);
    const customers = await t.run((ctx) => ctx.db.query("customers").collect());
    expect(customers).toHaveLength(1);
    const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
    expect(tasks.filter((task) => task.agent === "sales")).toHaveLength(1);
    // The stored key is a hash; the key itself is nowhere.
    const keys = await t.run((ctx) => ctx.db.query("googleLeadKeys").collect());
    expect(keys[0].keyHash).toBe(await hashToken(key));
  });

  it("Google's test data is kept to show the connection works, but never becomes a customer", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const { key } = await as.mutation(api.googleAds.rotateLeadKey, { companyId });
    await t.fetch("/webhooks/google/leads", { method: "POST", body: body(key, "T1", { is_test: true }) });
    expect((await as.query(api.googleAds.leads, { companyId })).leads[0]).toMatchObject({ test: true, customerId: null });
    expect(await t.run((ctx) => ctx.db.query("customers").collect())).toEqual([]);
  });

  it("parses the lead form body and reports conversions only with a click id, consent and a destination", () => {
    expect(parseLeadForm("not json")).toBeNull();
    expect(parseLeadForm(JSON.stringify({ lead_id: "x" }))).toBeNull();
    expect(parseLeadForm(body("k", "L9"))?.lead).toMatchObject({ externalId: "L9", name: "Jamie Rivera", postalCode: "78701", gclid: "gclid-1", campaign: "42", test: false });
    const job = { status: "completed" as const, priceCents: 16000 };
    expect(conversionEligibility({ job, lead: null, hasConsent: true, hasDestination: true })).toMatch(/did not come from a Google ad/);
    expect(conversionEligibility({ job, lead: { gclid: undefined, test: undefined }, hasConsent: true, hasDestination: true })).toMatch(/click id/);
    expect(conversionEligibility({ job, lead: { gclid: "g", test: undefined }, hasConsent: false, hasDestination: true })).toMatch(/consent/);
    expect(conversionEligibility({ job, lead: { gclid: "g", test: undefined }, hasConsent: true, hasDestination: false })).toMatch(/conversion action/);
    expect(conversionEligibility({ job: { status: "cancelled", priceCents: 1 }, lead: { gclid: "g", test: undefined }, hasConsent: true, hasDestination: true })).toMatch(/cancelled/);
    expect(conversionEligibility({ job, lead: { gclid: "g", test: undefined }, hasConsent: true, hasDestination: true })).toBeNull();
  });
});

describe("approvals before anything public or paid", () => {
  let t: T;
  beforeEach(() => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    t = start();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("a campaign draft spends nothing, only the Owner approves it with the exact budget, and turning it on is separate", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const manager = await addMember(t, as, companyId, "manager", "manager");
    await connect(t, as, companyId, { feature: "ads", grant: [SCOPE.ads] });
    await as.mutation(api.google.addResource, { companyId, kind: "ads_account", externalId: "1234567890", label: "Alpha Ads" });
    const { draftId, spends } = await manager.mutation(api.googleAds.draftCampaign, { companyId, accountId: "123-456-7890", name: "Spring", dailyBudgetCents: 2500, keywords: ["house cleaning"], postalCodes: ["78701"], headline: "Spotless homes", description: "Trusted cleaners near you.", headlines: ["Book in 60 seconds", "Insured local cleaners"], descriptions: ["Same team every visit."], finalUrl: "https://alpha.test" });
    expect(spends).toBe(false);
    expect(await refusal(manager.mutation(api.googleAds.approveCampaign, { companyId, draftId, confirmDailyBudgetCents: 2500 }))).toMatch(/not allowed|owner/i);
    expect(await refusal(as.mutation(api.googleAds.approveCampaign, { companyId, draftId, confirmDailyBudgetCents: 9900 }))).toMatch(/does not match/);
    expect(await refusal(as.mutation(api.googleAds.activateCampaign, { companyId, draftId, confirmDailyBudgetCents: 2500 }))).toMatch(/paused/);
    const approved = await as.mutation(api.googleAds.approveCampaign, { companyId, draftId, confirmDailyBudgetCents: 2500 });
    expect(approved.creates).toBe("a paused campaign");
    expect(await refusal(as.mutation(api.googleAds.draftCampaign, { companyId, accountId: "999-999-9999", name: "X", dailyBudgetCents: 2500, keywords: [], postalCodes: [], headline: "h", description: "d", finalUrl: "https://alpha.test" }))).toMatch(/not authorized/);
  });

  it("a review reply is published only as approved, and an uncertain earlier attempt is reconciled instead of posted twice", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connect(t, as, companyId, { feature: "business_profile", grant: [SCOPE.business] });
    await as.mutation(api.google.addResource, { companyId, kind: "business_location", externalId: "locations/22", label: "Alpha Austin", detail: "accounts/11" });
    const name = "accounts/11/locations/22/reviews/r1";
    const reviewId = await t.run((ctx) => ctx.db.insert("googleReviews", { companyId, location: "locations/22", reviewName: name, reviewer: "Pat", stars: 5, createdAt: 0, state: "new", seenAt: 0 }));
    const { jobId } = await as.mutation(api.googleBusiness.approveReply, { companyId, reviewId, text: "Thank you, Pat!" });
    // The earlier attempt's answer was lost: Google already has the approved text.
    await t.run((ctx) => ctx.db.patch(jobId, { status: "running", attempts: 2, checkpoint: "reconcile" }));
    const google = fakeGoogleApi({
      "oauth2.googleapis.com/token": () => ({ body: { access_token: "a", scope: [SCOPE.business].join(" ") } }),
      [`/${name}`]: () => ({ body: { name, reviewReply: { comment: "Thank you, Pat!" } } }),
    });
    await t.action(internal.googleWork.run, { jobId });
    expect(google.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status: "done" });
    expect(await t.run((ctx) => ctx.db.get(reviewId))).toMatchObject({ state: "published", existingReply: "Thank you, Pat!" });
  });
});

describe("calendar changes made in Google", () => {
  let t: T;
  beforeEach(() => {
    t = start();
  });

  it("ignores a notification without the channel's own token, and asks a person once per change", async () => {
    const { companyId } = await company(t, "owner", "Alpha");
    const { jobId } = await t.run(async (ctx) => {
      const customerId = await ctx.db.insert("customers", { companyId, name: "Dana", kind: "home", status: "active", createdAt: 0 });
      const propertyId = await ctx.db.insert("properties", { companyId, customerId, kind: "home", address: { line1: "1 Main", city: "Austin", region: "TX", postalCode: "78701" }, status: "active", createdAt: 0 });
      const jobId = await ctx.db.insert("jobs", { companyId, customerId, propertyId, serviceType: "standard", scope: "x", requiredSkills: [], startsAt: 0, endsAt: 1, status: "scheduled", createdAt: 0 });
      const memberId = (await ctx.db.query("members").first())!._id;
      const connectionId = await ctx.db.insert("googleConnections", { companyId, googleSub: "s", email: "o@a.test", status: "connected", grantedScopes: [], connectedBy: memberId, connectedAt: 0 });
      await ctx.db.insert("googleWatches", { companyId, connectionId, kind: "calendar", target: "cal", channelId: "selestial-chan", resourceId: "res", tokenHash: await hashToken("right-token-0123456789"), expiresAt: Date.now() + 1e9, createdAt: 0 });
      await ctx.db.insert("googleCalendarLinks", { companyId, calendarId: "cal", subject: { table: "jobs", id: jobId }, subjectId: jobId, eventId: "ev1", writtenHash: "h", updatedAt: 0 });
      return { jobId };
    });
    expect(await t.mutation(internal.googleCalendar.notified, { channelId: "selestial-chan", tokenHash: await hashToken("wrong-token-0123456789"), state: "exists", resourceId: "res" })).toBe("ignored");
    expect(await t.mutation(internal.googleCalendar.notified, { channelId: "selestial-chan", tokenHash: await hashToken("right-token-0123456789"), state: "sync", resourceId: "res" })).toBe("handshake");
    await t.mutation(internal.googleCalendar.externalChange, { companyId, eventId: "ev1", change: "moved" });
    await t.mutation(internal.googleCalendar.externalChange, { companyId, eventId: "ev1", change: "moved" });
    const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toMatch(/moved outside Selestial/);
    // The visit itself is untouched.
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ startsAt: 0, endsAt: 1 });
  });
});

describe("Google calls and scopes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never calls a host outside the allowlist, and treats a lost write as uncertain rather than failed", async () => {
    await expect(googleCall("https://evil.example.test/x", "t")).rejects.toMatchObject({ kind: "invalid" });
    const fetcher = vi.fn(async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    await expect(googleCall("https://www.googleapis.com/drive/v3/files", "t", { method: "POST", body: {}, fetcher })).rejects.toMatchObject({ kind: "uncertain" });
    const server = vi.fn(async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    const error = await googleCall("https://www.googleapis.com/drive/v3/files", "t", { method: "POST", body: {}, fetcher: server }).catch((e: GoogleError) => e);
    expect((error as GoogleError).kind).toBe("uncertain");
    expect(backoff(1)).toBe(30_000);
    expect(backoff(10)).toBe(2 * 60 * 60 * 1000);
  });

  it("turns on a feature only when all of its scopes were granted, and asks Gmail for sending only when allowed", () => {
    expect(enabledFeatures([SCOPE.calendarEvents])).toEqual([]);
    expect(enabledFeatures([SCOPE.calendarEvents, SCOPE.calendarList, SCOPE.calendarFreeBusy])).toEqual(["calendar"]);
    expect(gmailScopes(false)).not.toContain("https://www.googleapis.com/auth/gmail.send");
    expect(gmailScopes(true)).toContain("https://www.googleapis.com/auth/gmail.send");
  });
});

describe("Chat's Google tools", () => {
  it("drafts are reported as drafts, a paused agent is refused, and reads return the company's own records", async () => {
    const { GOOGLE_TOOLS } = await import("./lib/chat/googleTools");
    const tool = (name: string) => GOOGLE_TOOLS.find((t) => t.name === name)!;
    const t = start();
    const { companyId } = await company(t, "owner", "Alpha");
    const other = await company(t, "owner-b", "Bravo");
    await t.run(async (ctx) => {
      const company = (await ctx.db.get(companyId))!;
      const member = (await ctx.db.query("members").collect()).find((m) => m.companyId === companyId)!;
      const reviewId = await ctx.db.insert("googleReviews", { companyId, location: "locations/1", reviewName: "accounts/1/locations/1/reviews/r1", reviewer: "Pat", stars: 4, createdAt: 0, state: "new", seenAt: 0 });
      await ctx.db.insert("googleReviews", { companyId: other.companyId, location: "locations/9", reviewName: "accounts/9/locations/9/reviews/x", reviewer: "Not ours", stars: 1, createdAt: 0, state: "new", seenAt: 0 });
      const toolCtx = { ...ctx, company, member, role: "owner" as const, conversationId: "c" as never, runId: "r" as never, idempotencyKey: "k" };
      const listed = await tool("list_google_reviews").run(toolCtx, {});
      expect(listed.status).toBe("done");
      expect(JSON.stringify(listed)).not.toContain("Not ours");
      const drafted = await tool("draft_google_review_reply").run(toolCtx, { reviewId, text: "Thanks, Pat!" });
      expect(drafted).toMatchObject({ status: "proposed", data: { posted: false } });
      expect(await ctx.db.get(reviewId)).toMatchObject({ state: "drafted", draftBy: "assistant" });
      await ctx.db.patch(companyId, { pausedAgents: ["retention"] });
      const paused = await tool("draft_google_review_reply").run({ ...toolCtx, company: (await ctx.db.get(companyId))! }, { reviewId, text: "Again" });
      expect(paused).toMatchObject({ status: "refused" });
      const status = await tool("google_status").run(toolCtx, {});
      expect(status).toMatchObject({ status: "done", data: { connected: false } });
      expect(tool("publish_google_review_reply")).toMatchObject({ confirm: true, minimumRole: "manager" });
    });
  });
});

describe("a backend that is not production never writes to a Google account", () => {
  const TEST_BACKEND = "https://terrific-avocet-835.convex.cloud";
  const LIVE_BACKEND = "https://stoic-gazelle-731.convex.cloud";
  // convex/googleWork.ts HELD_MAX_AGE_MS. Written out: importing that module here changes the order modules load in for the whole file.
  const HELD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  let t: T;
  beforeEach(() => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    t = start();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("knows a write from a read: signing in, queries and busy times are reads; events, replies, ads, conversions and files are writes", () => {
    const reads: [string, string][] = [
      ["https://www.googleapis.com/calendar/v3/users/me/calendarList", "GET"],
      ["https://oauth2.googleapis.com/token", "POST"],
      ["https://oauth2.googleapis.com/revoke", "POST"],
      ["https://www.googleapis.com/calendar/v3/freeBusy", "POST"],
      ["https://googleads.googleapis.com/v21/customers/123/googleAds:search", "POST"],
      ["https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", "POST"],
    ];
    const writes: [string, string][] = [
      ["https://www.googleapis.com/calendar/v3/calendars/c/events?sendUpdates=none", "POST"],
      ["https://www.googleapis.com/calendar/v3/calendars/c/events/e?sendUpdates=none", "PUT"],
      ["https://www.googleapis.com/calendar/v3/calendars/c/events/e?sendUpdates=none", "DELETE"],
      ["https://www.googleapis.com/calendar/v3/calendars/c/events/watch", "POST"],
      ["https://www.googleapis.com/calendar/v3/channels/stop", "POST"],
      ["https://mybusiness.googleapis.com/v4/accounts/1/locations/2/reviews/3/reply", "PUT"],
      ["https://mybusinessnotifications.googleapis.com/v1/accounts/1/notificationSetting?updateMask=pubsubTopic", "PATCH"],
      ["https://googleads.googleapis.com/v21/customers/123/campaigns:mutate", "POST"],
      ["https://googleads.googleapis.com/v21/customers/123/campaignBudgets:mutate", "POST"],
      ["https://datamanager.googleapis.com/v1/events:ingest", "POST"],
      ["https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", "POST"],
      ["https://sheets.googleapis.com/v4/spreadsheets/s/values/A1?valueInputOption=RAW", "PUT"],
    ];
    for (const [url, method] of reads) expect(writesToGoogle(url, method), `${method} ${url}`).toBe(false);
    for (const [url, method] of writes) expect(writesToGoogle(url, method), `${method} ${url}`).toBe(true);
  });

  it("refuses every write at the one call wrapper, and lets reads, sign-in and production through", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const write = () => googleCall("https://www.googleapis.com/calendar/v3/calendars/c/events?sendUpdates=none", "t", { method: "POST", body: {}, fetcher });
    vi.stubEnv("CONVEX_CLOUD_URL", TEST_BACKEND);
    const refused = await write().catch((e: GoogleError) => e);
    expect(refused).toMatchObject({ kind: "not_production", message: NOT_RUN_ON_TEST, retryable: false });
    await expect(googleCall("https://googleads.googleapis.com/v21/customers/1/campaigns:mutate", "t", { method: "POST", body: {}, fetcher })).rejects.toMatchObject({ kind: "not_production" });
    expect(fetcher).not.toHaveBeenCalled();
    // Reads and token exchange still work there.
    await googleCall("https://www.googleapis.com/calendar/v3/users/me/calendarList", "t", { fetcher });
    await googleCall("https://oauth2.googleapis.com/token", null, { method: "POST", rawBody: "grant_type=refresh_token", fetcher });
    await googleCall("https://www.googleapis.com/calendar/v3/freeBusy", "t", { method: "POST", body: {}, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(3);
    // Production writes.
    vi.stubEnv("CONVEX_CLOUD_URL", LIVE_BACKEND);
    await write();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("a job that would write is settled once as not run: not failed, not retried, and nothing reaches Google", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connect(t, as, companyId, { feature: "business_profile", grant: [SCOPE.business] });
    await as.mutation(api.google.addResource, { companyId, kind: "business_location", externalId: "locations/22", label: "Alpha Austin", detail: "accounts/11" });
    const name = "accounts/11/locations/22/reviews/r1";
    const reviewId = await t.run((ctx) => ctx.db.insert("googleReviews", { companyId, location: "locations/22", reviewName: name, reviewer: "Pat", stars: 5, createdAt: 0, state: "new", seenAt: 0 }));
    const { jobId } = await as.mutation(api.googleBusiness.approveReply, { companyId, reviewId, text: "Thank you, Pat!" });
    await t.run((ctx) => ctx.db.patch(jobId, { status: "running", attempts: 1 }));
    // The old backend: a copy of real rows and real Google access, but not production by name.
    vi.stubEnv("CONVEX_CLOUD_URL", TEST_BACKEND);
    const google = fakeGoogleApi({
      "oauth2.googleapis.com/token": () => ({ body: { access_token: "a", scope: [SCOPE.business].join(" ") } }),
      [`/${name}`]: () => ({ body: { name } }),
    });
    await t.action(internal.googleWork.run, { jobId });
    // It signed in (allowed), and wrote nothing.
    expect(google.calls.some((c) => c.url.includes("oauth2.googleapis.com/token"))).toBe(true);
    expect(google.calls.filter((c) => c.method !== "GET" && !c.url.includes("oauth2.googleapis.com"))).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status: "cancelled", lastError: NOT_RUN_ON_TEST });
    expect((await t.run((ctx) => ctx.db.get(reviewId)))!.state).not.toBe("published");
    expect(await t.run(async (ctx) => (await ctx.db.query("events").collect()).filter((e) => e.type === "google.job_failed"))).toEqual([]);
    // Settled: a second run finds nothing to do.
    await t.action(internal.googleWork.run, { jobId });
    expect((await t.run((ctx) => ctx.db.get(jobId)))!.status).toBe("cancelled");
  });

  it("opens no calendar channel and changes no review notification setting, without even asking Google", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connect(t, as, companyId, { feature: "calendar", grant: [SCOPE.calendarList, SCOPE.calendarEvents, SCOPE.calendarFreeBusy] });
    await t.run(async (ctx) => {
      const connection = (await ctx.db.query("googleConnections").collect())[0];
      await ctx.db.insert("googleResources", { companyId, connectionId: connection._id, kind: "calendar_sync", externalId: "work@alpha.test", label: "Work", access: "verified", addedBy: connection.connectedBy, createdAt: Date.now() });
    });
    // There is a calendar to watch: on production this would open a channel.
    expect(await t.query(internal.googleCalendar.watchTarget, { companyId })).not.toBeNull();
    vi.stubEnv("CONVEX_CLOUD_URL", TEST_BACKEND);
    vi.stubEnv("GOOGLE_PUBSUB_TOPIC", "projects/p/topics/reviews");
    const google = fakeGoogleApi({});
    expect(await t.action(internal.googleCalendar.ensureWatch, { companyId })).toBeNull();
    expect(await t.action(internal.googleBusiness.ensureNotifications, { companyId })).toBeNull();
    expect(google.calls).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("googleWatches").collect())).toEqual([]);
  });

  it("a public write held through a suspension runs if it is still fresh, and is cancelled and reported if it is not", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connect(t, as, companyId, { feature: "business_profile", grant: [SCOPE.business] });
    const now = Date.now();
    const job = (key: string, createdAt: number) =>
      t.run(async (ctx) => {
        const connection = (await ctx.db.query("googleConnections").collect())[0];
        return ctx.db.insert("googleJobs", { companyId, connectionId: connection._id, kind: "review_reply", key, status: "queued", payload: "{}", attempts: 0, nextAt: now - 1000, createdAt, updatedAt: createdAt });
      });
    const fresh = await job("reply:fresh", now - 60 * 60 * 1000);
    const stale = await job("reply:stale", now - HELD_MAX_AGE_MS - 60 * 1000);
    await t.run((ctx) => ctx.db.patch(companyId, { suspendedAt: now }));
    expect(await t.mutation(internal.googleWork.tick, {})).toBe(0);
    for (const id of [fresh, stale]) expect((await t.run((ctx) => ctx.db.get(id)))!.lastError).toMatch(/^Held:/);
    // Released: both are due again.
    await t.run(async (ctx) => {
      await ctx.db.patch(companyId, { suspendedAt: undefined });
      for (const id of [fresh, stale]) await ctx.db.patch(id, { nextAt: now - 1000 });
    });
    expect(await t.mutation(internal.googleWork.tick, {})).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(fresh)))!.status).toBe("running");
    expect(await t.run((ctx) => ctx.db.get(stale))).toMatchObject({ status: "cancelled" });
    expect((await t.run((ctx) => ctx.db.get(stale)))!.lastError).toMatch(/out of date/);
    const notices = await t.run((ctx) => ctx.db.query("memberNotices").collect());
    expect(notices.filter((n) => n.headline === "A review reply was not sent to Google")).toHaveLength(1);
    // A write that was never held is not cancelled for its age alone.
    const old = await job("reply:old", now - 3 * HELD_MAX_AGE_MS);
    await t.mutation(internal.googleWork.tick, {});
    expect((await t.run((ctx) => ctx.db.get(old)))!.status).toBe("running");
  });
});
