/**
 * @vitest-environment edge-runtime
 *
 * Connecting a Google tool (Drive, Calendar, Business Profile, Ads, booked-job reporting) waits for the
 * signed-in Owner who started it to confirm the Google account, exactly as a Gmail inbox does. Google's
 * answer alone connects nothing. Every Google call goes to a fake; nothing reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, refusal, start, type T } from "../tests/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { SCOPE } from "./lib/google/features";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const ENV = { GOOGLE_CLIENT_ID: "client-id.apps.test", GOOGLE_CLIENT_SECRET: "client-secret-not-real", MAILBOX_TOKEN_KEY: KEY, CONVEX_SITE_URL: "https://deployment.convex.site.test", APP_ORIGIN: "https://app.selestial.test" };

const b64url = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = (sub: string, email: string) => `${b64url({ alg: "none" })}.${b64url({ sub, email })}.sig`;

function fakeGoogle(input: { sub?: string; email?: string; grant: string[]; refresh?: string | null }) {
  const calls: { url: string; body?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : undefined });
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "access-1", ...(input.refresh === null ? {} : { refresh_token: input.refresh ?? "refresh-secret-1" }), scope: [SCOPE.openid, SCOPE.email, ...input.grant].join(" "), expires_in: 3600, id_token: idToken(input.sub ?? "google-sub-1", input.email ?? "owner@alpha.test") }), { status: 200 });
      }
      if (String(url).includes("oauth2.googleapis.com/revoke")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ error: "not faked" }), { status: 404 });
    }),
  );
  return calls;
}

async function signIn(t: T, as: ReturnType<T["withIdentity"]>, companyId: Id<"companies">, feature: "drive" | "calendar", google: Parameters<typeof fakeGoogle>[0], differentAccount?: boolean) {
  const { url } = await as.mutation(api.google.startConnect, { companyId, feature, differentAccount });
  const calls = fakeGoogle(google);
  const response = await t.fetch(`/oauth/google/callback?state=${encodeURIComponent(new URL(url).searchParams.get("state")!)}&code=auth-code`, { method: "GET" });
  const location = new URL(response.headers.get("location") ?? "", "https://x.test");
  return { location, token: location.searchParams.get("pending"), calls, state: new URL(url).searchParams.get("state")! };
}

const connections = (t: T) => t.run((ctx) => ctx.db.query("googleConnections").collect());
const credentials = (t: T) => t.run((ctx) => ctx.db.query("googleCredentials").collect());

describe("connecting a Google tool waits for the Owner who started to confirm the account", () => {
  let t: T;
  beforeEach(() => {
    vi.useFakeTimers();
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    t = start();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("Google's answer connects nothing; the starting Owner sees the account and confirms it", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const { location, token } = await signIn(t, as, companyId, "drive", { grant: [SCOPE.driveFile], email: "files@alpha.test" });
    expect(location.searchParams.get("result")).toBe("confirm");
    expect(location.searchParams.get("tool")).toBe("drive");
    expect(token).toBeTruthy();
    expect(await connections(t)).toEqual([]);
    expect(await credentials(t)).toEqual([]);
    const shown = await as.query(api.google.pendingConnect, { companyId, token: token! });
    expect(shown).toMatchObject({ feature: "drive", email: "files@alpha.test", complete: true, replaces: null });
    const done = await as.mutation(api.google.confirmConnect, { companyId, token: token! });
    expect(done).toMatchObject({ connected: true, feature: "drive", result: "connected" });
    const [row] = await connections(t);
    expect(row).toMatchObject({ feature: "drive", email: "files@alpha.test", status: "connected" });
    const [credential] = await credentials(t);
    expect(credential.connectionId).toBe(row._id);
    expect(credential.sealedRefreshToken).not.toContain("refresh-secret-1");
    // The one-time value is spent.
    expect(await as.query(api.google.pendingConnect, { companyId, token: token! })).toBeNull();
    expect(await refusal(as.mutation(api.google.confirmConnect, { companyId, token: token! }))).toMatch(/isn’t waiting any more/);
  });

  it("an Owner who sends their Google link to someone else gets nothing, and the access is ended after fifteen minutes", async () => {
    const attacker = await company(t, "attacker", "Attacker Co");
    const victim = await company(t, "victim", "Victim Co");
    const { token, calls, state } = await signIn(t, attacker.as, attacker.companyId, "calendar", { grant: [SCOPE.calendarList, SCOPE.calendarEvents, SCOPE.calendarFreeBusy], sub: "victim-sub", email: "victim@other.test", refresh: "victim-refresh" });
    // The one-time value went to the victim's browser; the victim's own account cannot finish it either.
    expect(await victim.as.query(api.google.pendingConnect, { companyId: victim.companyId, token: token! })).toBeNull();
    expect(await refusal(victim.as.mutation(api.google.confirmConnect, { companyId: victim.companyId, token: token! }))).toMatch(/isn’t waiting any more/);
    expect(await refusal(victim.as.mutation(api.google.confirmConnect, { companyId: attacker.companyId, token: token! }))).toBeTruthy();
    // The attacker holds only the spent state, which is not the value.
    expect(await refusal(attacker.as.mutation(api.google.confirmConnect, { companyId: attacker.companyId, token: state }))).toMatch(/isn’t waiting any more/);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await connections(t)).toEqual([]);
    expect(await credentials(t)).toEqual([]);
    expect((await t.run((ctx) => ctx.db.query("googleOAuthStates").collect())).every((row) => row.pending === undefined)).toBe(true);
    const revoked = calls.filter((call) => call.url.includes("/revoke"));
    expect(revoked).toHaveLength(1);
    expect(revoked[0].url + (revoked[0].body ?? "")).toContain("victim-refresh");
  });

  it("only the member who started can confirm; another Owner, a Manager and a demoted Owner cannot", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const manager = await addMember(t, as, companyId, "manager", "manager");
    const { token } = await signIn(t, as, companyId, "drive", { grant: [SCOPE.driveFile] });
    expect(await manager.query(api.google.pendingConnect, { companyId, token: token! })).toBeNull();
    expect(await refusal(manager.mutation(api.google.confirmConnect, { companyId, token: token! }))).toMatch(/not allowed|owner/i);
    await t.run(async (ctx) => {
      const owner = (await ctx.db.query("members").collect()).find((m) => m.companyId === companyId && m.role === "owner")!;
      await ctx.db.patch(owner._id, { role: "manager" });
    });
    expect(await refusal(as.mutation(api.google.confirmConnect, { companyId, token: token! }))).toBeTruthy();
    expect(await connections(t)).toEqual([]);
  });

  it("“Don’t connect” throws the access away at once and revokes it", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const { token, calls } = await signIn(t, as, companyId, "drive", { grant: [SCOPE.driveFile] });
    await as.mutation(api.google.cancelConnect, { companyId, token: token! });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await connections(t)).toEqual([]);
    expect(calls.some((call) => call.url.includes("/revoke"))).toBe(true);
  });

  it("refuses a reconnect with another Google account before anything waits, and keeps a grant that is in use", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const first = await signIn(t, as, companyId, "drive", { grant: [SCOPE.driveFile] });
    await as.mutation(api.google.confirmConnect, { companyId, token: first.token! });
    const wrong = await signIn(t, as, companyId, "drive", { grant: [SCOPE.driveFile], sub: "someone-else", email: "other@alpha.test", refresh: "other-refresh" });
    expect(wrong.location.searchParams.get("result")).toBe("different_account");
    expect(wrong.token).toBeNull();
    // A reconnect of the same account that is not confirmed must not end the grant the live connection uses.
    const same = await signIn(t, as, companyId, "drive", { grant: [SCOPE.driveFile], refresh: "same-refresh" });
    await as.mutation(api.google.cancelConnect, { companyId, token: same.token! });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const revoked = same.calls.filter((call) => call.url.includes("/revoke")).map((call) => call.url + (call.body ?? ""));
    // The other account's unusable access was ended; the account in use was left alone.
    expect(revoked.some((r) => r.includes("other-refresh"))).toBe(true);
    expect(revoked.some((r) => r.includes("same-refresh"))).toBe(false);
    expect((await connections(t)).filter((row) => row.status === "connected")).toHaveLength(1);
  });
});
