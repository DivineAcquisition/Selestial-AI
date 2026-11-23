/**
 * @vitest-environment edge-runtime
 *
 * Google Business Profile: every page of accounts and locations is read; a location's Google review page is
 * kept and is the review link Retention's feedback page offers every customer; Retention drafts a reply to
 * each new review and never posts it. Also: a test backend opens no Gmail watch. Every Google call is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { company, start, type T } from "../tests/harness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { draftFor } from "./googleBusiness";
import { accounts, locations } from "./lib/google/business";
import { NOT_RUN_ON_TEST } from "./lib/google/http";
import { reviewLinkFor } from "./lib/google/reviewLink";
import { watchMailbox } from "./lib/recruiter/gmail";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const ENV = { GOOGLE_CLIENT_ID: "client-id.apps.test", GOOGLE_CLIENT_SECRET: "client-secret-not-real", MAILBOX_TOKEN_KEY: KEY, CONVEX_SITE_URL: "https://deployment.convex.site.test", APP_ORIGIN: "https://app.selestial.test" };
const TEST_BACKEND = "https://terrific-avocet-835.convex.cloud";
const REVIEW_PAGE = "https://search.google.com/local/writereview?placeid=ChIJ-test";
const b64url = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

type Route = (url: string, init?: RequestInit) => unknown;
function fake(routes: Record<string, Route>) {
  const calls: { url: string; method: string }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    const key = Object.keys(routes).find((part) => url.includes(part));
    if (!key) return new Response(JSON.stringify({ error: "not faked" }), { status: 404 });
    return new Response(JSON.stringify(routes[key](url, init)), { status: 200 });
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}

const TOKEN_ROUTE: Record<string, Route> = {
  "oauth2.googleapis.com/token": () => ({ access_token: "access-1", refresh_token: "refresh-1", scope: "openid email https://www.googleapis.com/auth/business.manage", expires_in: 3600, id_token: `${b64url({ alg: "none" })}.${b64url({ sub: "sub-1", email: "owner@alpha.test" })}.sig` }),
};

async function connectBusiness(t: T, as: ReturnType<T["withIdentity"]>, companyId: Id<"companies">) {
  const { url } = await as.mutation(api.google.startConnect, { companyId, feature: "business_profile" });
  fake(TOKEN_ROUTE);
  const response = await t.fetch(`/oauth/google/callback?state=${encodeURIComponent(new URL(url).searchParams.get("state")!)}&code=c`, { method: "GET" });
  await as.mutation(api.google.confirmConnect, { companyId, token: new URL(response.headers.get("location")!).searchParams.get("pending")! });
}

describe("Google Business Profile", () => {
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

  it("reads every page of accounts and locations, with each location's review page", async () => {
    const { calls, fetcher } = fake({
      "/accounts?": (url) => (url.includes("pageToken=p2") ? { accounts: [{ name: "accounts/2" }] } : { accounts: [{ name: "accounts/1" }], nextPageToken: "p2" }),
      "/accounts/1/locations": (url) => (url.includes("pageToken=l2") ? { locations: [{ name: "locations/12", metadata: { newReviewUri: REVIEW_PAGE } }] } : { locations: [{ name: "locations/11" }], nextPageToken: "l2" }),
    });
    expect((await accounts("t", fetcher)).map((a) => a.name)).toEqual(["accounts/1", "accounts/2"]);
    const found = await locations("t", "accounts/1", fetcher);
    expect(found.map((l) => l.name)).toEqual(["locations/11", "locations/12"]);
    expect(found[1].metadata?.newReviewUri).toBe(REVIEW_PAGE);
    expect(calls.some((call) => call.url.includes("readMask=name,title,storefrontAddress,metadata"))).toBe(true);
  });

  it("keeps a verified location's review page as the review link, unless the Playbook names one", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connectBusiness(t, as, companyId);
    const resourceId = await as.mutation(api.google.addResource, { companyId, kind: "business_location", externalId: "locations/22", label: "Alpha Austin", detail: "accounts/11" });
    fake({ ...TOKEN_ROUTE, "/accounts/11/locations": () => ({ locations: [{ name: "locations/22", metadata: { newReviewUri: REVIEW_PAGE } }] }) });
    await t.action(internal.googleWork.verifyResource, { resourceId });
    expect(await t.run((ctx) => ctx.db.get(resourceId))).toMatchObject({ access: "verified", reviewUri: REVIEW_PAGE, detail: "accounts/11" });
    expect(await t.run(async (ctx) => reviewLinkFor(ctx, (await ctx.db.get(companyId))!))).toBe(REVIEW_PAGE);
    // The Owner's own link in the Retention Playbook comes first.
    await t.run(async (ctx) => ctx.db.patch(companyId, { retention: { ...((await ctx.db.get(companyId))!.retention ?? {}), reviewUrl: "https://reviews.example.test/alpha" } }));
    expect(await t.run(async (ctx) => reviewLinkFor(ctx, (await ctx.db.get(companyId))!))).toBe("https://reviews.example.test/alpha");
    // Disconnected: the location's page is no longer offered.
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(companyId))!;
      await ctx.db.patch(companyId, { retention: { ...(row.retention ?? {}), reviewUrl: undefined } });
    });
    await as.mutation(api.google.disconnect, { companyId, feature: "business_profile" });
    expect(await t.run(async (ctx) => reviewLinkFor(ctx, (await ctx.db.get(companyId))!))).toBeNull();
  });

  it("only Google's own pages are kept as a review link", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connectBusiness(t, as, companyId);
    const resourceId = await as.mutation(api.google.addResource, { companyId, kind: "business_location", externalId: "locations/22", label: "Alpha", detail: "accounts/11" });
    await t.mutation(internal.google.setResourceAccess, { resourceId, access: "verified", reviewUri: "https://evil.example.test/review" });
    expect((await t.run((ctx) => ctx.db.get(resourceId)))!.reviewUri).toBeUndefined();
  });

  it("drafts a reply to each new review whatever its rating, for approval, and posts nothing", async () => {
    const { companyId } = await company(t, "owner", "Alpha");
    const { calls } = fake({});
    const review = (name: string, stars: number, existingReply?: string) => ({ reviewName: `accounts/1/locations/2/reviews/${name}`, reviewer: "Pat Lee", stars, comment: "words", createdAt: 1, ...(existingReply ? { existingReply } : {}) });
    await t.mutation(internal.googleBusiness.storeReviews, { companyId, location: "locations/2", reviews: [review("a", 5), review("b", 1), review("c", 4, "Thanks!")] });
    const rows = await t.run((ctx) => ctx.db.query("googleReviews").collect());
    const by = (name: string) => rows.find((r) => r.reviewName.endsWith(`/${name}`))!;
    expect(by("a")).toMatchObject({ state: "drafted", draftBy: "assistant" });
    expect(by("b")).toMatchObject({ state: "drafted", draftBy: "assistant" });
    expect(by("a").draft).toContain("Thank you Pat");
    expect(by("a").draft).not.toContain("Lee");
    expect(by("c").state).toBe("published");
    expect(by("c").draft).toBeUndefined();
    // Nothing is published or queued for Google.
    expect(await t.run((ctx) => ctx.db.query("googleJobs").collect())).toEqual([]);
    expect(rows.every((r) => r.approvedText === undefined)).toBe(true);
    expect(calls).toEqual([]);
    const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
    expect(tasks.filter((task) => task.nextAction.includes("Retention drafted a reply"))).toHaveLength(2);
  });

  it("drafts nothing while Retention's permission to draft review replies is off", async () => {
    const { companyId } = await company(t, "owner", "Alpha");
    await t.run(async (ctx) => {
      const owner = (await ctx.db.query("members").collect()).find((m) => m.companyId === companyId)!;
      await ctx.db.insert("permissions", { companyId, action: "retention.draft_review_reply", level: "off", updatedBy: owner._id, updatedAt: Date.now() });
    });
    await t.mutation(internal.googleBusiness.storeReviews, { companyId, location: "locations/2", reviews: [{ reviewName: "accounts/1/locations/2/reviews/z", reviewer: "Sam", stars: 2, createdAt: 1 }] });
    expect((await t.run((ctx) => ctx.db.query("googleReviews").collect()))[0]).toMatchObject({ state: "new" });
  });

  it("a starting draft never repeats the reviewer's words or details", () => {
    for (const stars of [1, 2, 3, 4, 5]) {
      const draft = draftFor({ reviewer: "Jordan Q. Public", stars, comment: "My address is 12 Elm St" }, "Alpha Cleaning");
      expect(draft).not.toContain("Elm");
      expect(draft).not.toContain("Public");
      expect(draft).toContain("Alpha Cleaning");
    }
  });
});

describe("Gmail watch on a backend that is not production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("never asks Gmail to watch a mailbox", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", TEST_BACKEND);
    const fetcher = vi.fn();
    await expect(watchMailbox({ token: "t", topic: "projects/p/topics/gmail", fetch: fetcher as unknown as typeof fetch })).rejects.toThrow(NOT_RUN_ON_TEST);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
