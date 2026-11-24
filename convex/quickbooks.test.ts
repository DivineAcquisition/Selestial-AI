/**
 * @vitest-environment edge-runtime
 *
 * QuickBooks Online: connecting, disconnecting and reconnecting against a fake Intuit (discovery document,
 * token endpoint, accounting API, revocation). Nothing reaches the network. Covers the cases Intuit asks
 * apps to handle: expired access tokens, expired or revoked refresh tokens (invalid_grant), CSRF (state)
 * errors, transient failures with retries, and asking the Owner to reconnect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, refusal, start, type T } from "../tests/harness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { forgetDiscoveryForTests } from "./lib/quickbooks/oauth";
import { setQuickBooksFetchForTests } from "./quickbooks";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 11)));
const ENV = { QUICKBOOKS_CLIENT_ID: "qbo-client-id", QUICKBOOKS_CLIENT_SECRET: "qbo-client-secret-not-real", QUICKBOOKS_ENVIRONMENT: "sandbox", MAILBOX_TOKEN_KEY: KEY, CONVEX_SITE_URL: "https://deployment.convex.site.test", APP_ORIGIN: "https://app.selestial.test" };
const REALM = "9130350000000001";

type Call = { url: string; method: string; body: string; auth: string | null };
type Script = {
  /** What the token endpoint answers to a refresh, in order; the last one repeats. */
  refresh?: ("ok" | "invalid_grant" | "busy")[];
  /** What the API answers to CompanyInfo, in order; the last one repeats. */
  api?: ("ok" | "unauthorized" | "busy")[];
};

function fakeIntuit(script: Script = {}) {
  const calls: Call[] = [];
  let issued = 0;
  const refreshes = [...(script.refresh ?? ["ok"])];
  const answers = [...(script.api ?? ["ok"])];
  const next = <X,>(list: X[]) => (list.length > 1 ? list.shift()! : list[0]);
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", intuit_tid: `tid-${calls.length}` } });
  setQuickBooksFetchForTests(
    async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url, method: init?.method ?? "GET", body, auth: new Headers(init?.headers).get("Authorization") });
      if (url.includes("/.well-known/openid")) return json({ issuer: "https://oauth.platform.intuit.com/op/v1", authorization_endpoint: "https://appcenter.intuit.com/connect/oauth2", token_endpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", revocation_endpoint: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke" });
      if (url.endsWith("/oauth2/v1/tokens/bearer")) {
        const form = new URLSearchParams(body);
        if (form.get("grant_type") === "refresh_token") {
          const outcome = next(refreshes);
          if (outcome === "invalid_grant") return json({ error: "invalid_grant" }, 400);
          if (outcome === "busy") return json({ error: "server_error" }, 503);
        }
        issued += 1;
        return json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, token_type: "bearer", expires_in: 3600, x_refresh_token_expires_in: 8_726_400 });
      }
      if (url.includes("/v3/company/")) {
        const outcome = next(answers);
        if (outcome === "unauthorized") return json({ fault: "AuthenticationFailed" }, 401);
        if (outcome === "busy") return json({ fault: "busy" }, 503);
        return json({ CompanyInfo: { CompanyName: "Sandbox Cleaning Co" } });
      }
      if (url.endsWith("/v2/oauth2/tokens/revoke")) return json({});
      return json({ error: "not faked" }, 404);
    },
    async () => {},
  );
  return calls;
}

const connections = (t: T) => t.run((ctx) => ctx.db.query("quickbooksConnections").collect());
const credentials = (t: T) => t.run((ctx) => ctx.db.query("quickbooksCredentials").collect());

async function connect(t: T, as: ReturnType<T["withIdentity"]>, companyId: Id<"companies">, query?: (state: string) => string) {
  const { url } = await as.mutation(api.quickbooks.startConnect, { companyId, returnTo: "https://app.selestial.test" });
  const state = new URL(url).searchParams.get("state")!;
  const response = await t.fetch(`/oauth/quickbooks/callback?${query ? query(state) : `state=${encodeURIComponent(state)}&code=auth-code&realmId=${REALM}`}`, { method: "GET" });
  const location = new URL(response.headers.get("location") ?? "", "https://x.test");
  return { url: new URL(url), state, result: location.searchParams.get("result"), location };
}

describe("QuickBooks Online", () => {
  let t: T;
  beforeEach(() => {
    vi.useFakeTimers();
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    forgetDiscoveryForTests();
    t = start();
  });
  afterEach(() => {
    setQuickBooksFetchForTests(null);
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("is unavailable until the Intuit app is configured, and only the Owner may connect", async () => {
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    vi.stubEnv("QUICKBOOKS_CLIENT_ID", "");
    expect(await as.query(api.quickbooks.status, { companyId })).toMatchObject({ available: false, connection: null });
    expect(await refusal(as.mutation(api.quickbooks.startConnect, { companyId }))).toContain("isn’t available");
    vi.stubEnv("QUICKBOOKS_CLIENT_ID", ENV.QUICKBOOKS_CLIENT_ID);
    const manager = await addMember(t, as, companyId, "manager-a", "manager");
    expect(await refusal(manager.mutation(api.quickbooks.startConnect, { companyId }))).toBe("Not allowed.");
    expect(await manager.query(api.quickbooks.status, { companyId })).toMatchObject({ available: true, canManage: false });
  });

  it("connects: Intuit's sign-in from the discovery document, a one-time state, sealed tokens, and the company's name read back", async () => {
    const calls = fakeIntuit();
    const { as, companyId } = await company(t, "owner-b", "Beta Cleaning");
    const { url, result, state } = await connect(t, as, companyId);
    expect(`${url.origin}${url.pathname}`).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(url.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(url.searchParams.get("redirect_uri")).toBe("https://deployment.convex.site.test/oauth/quickbooks/callback");
    expect(result).toBe("connected");

    // The code was exchanged with the app's own credentials (Basic auth), at the discovered token endpoint.
    const exchange = calls.find((call) => call.url.endsWith("/tokens/bearer"))!;
    expect(exchange.auth).toBe(`Basic ${btoa("qbo-client-id:qbo-client-secret-not-real")}`);
    expect(new URLSearchParams(exchange.body).get("grant_type")).toBe("authorization_code");

    const [row] = await connections(t);
    expect(row).toMatchObject({ realmId: REALM, environment: "sandbox", status: "connected", companyName: "Sandbox Cleaning Co" });
    const [credential] = await credentials(t);
    expect(credential.sealedRefreshToken).not.toContain("refresh-1");
    expect(credential.sealedAccessToken).not.toContain("access-1");
    expect(await as.query(api.quickbooks.status, { companyId })).toMatchObject({ connection: { status: "connected", companyName: "Sandbox Cleaning Co" } });

    // The state works once: replaying the same callback is refused, and nothing new is exchanged.
    const before = calls.length;
    const replay = await t.fetch(`/oauth/quickbooks/callback?state=${encodeURIComponent(state)}&code=auth-code&realmId=${REALM}`, { method: "GET" });
    expect(new URL(replay.headers.get("location")!).searchParams.get("result")).toBe("expired");
    expect(calls.slice(before).some((call) => call.url.endsWith("/tokens/bearer"))).toBe(false);
  });

  it("refuses a callback with a missing or unknown state (CSRF), a denied consent, or no company id", async () => {
    const calls = fakeIntuit();
    const { as, companyId } = await company(t, "owner-c", "Gamma Cleaning");
    expect((await connect(t, as, companyId, () => `code=auth-code&realmId=${REALM}`)).result).toBe("failed");
    expect((await connect(t, as, companyId, () => `state=forged-state&code=auth-code&realmId=${REALM}`)).result).toBe("failed");
    expect((await connect(t, as, companyId, (state) => `state=${encodeURIComponent(state)}&error=access_denied`)).result).toBe("declined");
    expect((await connect(t, as, companyId, (state) => `state=${encodeURIComponent(state)}&code=auth-code`)).result).toBe("failed");
    // An expired state: ten minutes is the limit.
    const { url } = await as.mutation(api.quickbooks.startConnect, { companyId });
    vi.advanceTimersByTime(11 * 60 * 1000);
    const late = await t.fetch(`/oauth/quickbooks/callback?state=${encodeURIComponent(new URL(url).searchParams.get("state")!)}&code=auth-code&realmId=${REALM}`, { method: "GET" });
    expect(new URL(late.headers.get("location")!).searchParams.get("result")).toBe("expired");
    expect(calls.some((call) => call.url.endsWith("/tokens/bearer"))).toBe(false);
    expect(await connections(t)).toEqual([]);
  });

  it("reuses the access token while it is valid, refreshes it before it expires, and keeps Intuit's newest refresh token", async () => {
    const calls = fakeIntuit();
    const { as, companyId } = await company(t, "owner-d", "Delta Cleaning");
    await connect(t, as, companyId);
    const [row] = await connections(t);
    const refreshCalls = () => calls.filter((call) => new URLSearchParams(call.body).get("grant_type") === "refresh_token");

    expect(await t.action(internal.quickbooks.check, { connectionId: row._id })).toMatchObject({ ok: true });
    expect(refreshCalls()).toHaveLength(0);

    // 57 minutes on, the hour-long token has under five minutes left: it is refreshed first.
    vi.advanceTimersByTime(57 * 60 * 1000);
    expect(await t.action(internal.quickbooks.check, { connectionId: row._id })).toMatchObject({ ok: true });
    expect(refreshCalls()).toHaveLength(1);
    expect(new URLSearchParams(refreshCalls()[0].body).get("refresh_token")).toBe("refresh-1");
    const api1 = calls.filter((call) => call.url.includes("/v3/company/")).at(-1)!;
    expect(api1.auth).toBe("Bearer access-2");

    // The next refresh uses the rotated refresh token, never the retired one.
    vi.advanceTimersByTime(57 * 60 * 1000);
    await t.action(internal.quickbooks.check, { connectionId: row._id });
    expect(new URLSearchParams(refreshCalls()[1].body).get("refresh_token")).toBe("refresh-2");
  });

  it("refreshes once and tries again when QuickBooks refuses an access token that should still be valid", async () => {
    const calls = fakeIntuit({ api: ["ok", "unauthorized", "ok"] });
    const { as, companyId } = await company(t, "owner-e", "Echo Cleaning");
    await connect(t, as, companyId);
    const [row] = await connections(t);
    expect(await t.action(internal.quickbooks.check, { connectionId: row._id })).toMatchObject({ ok: true });
    expect(calls.filter((call) => new URLSearchParams(call.body).get("grant_type") === "refresh_token")).toHaveLength(1);
    expect((await connections(t))[0].status).toBe("connected");
  });

  it("retries transient failures from Intuit, and reports them without disconnecting", async () => {
    fakeIntuit({ api: ["ok", "busy", "busy", "ok"] });
    const { as, companyId } = await company(t, "owner-f", "Foxtrot Cleaning");
    await connect(t, as, companyId);
    const [row] = await connections(t);
    expect(await t.action(internal.quickbooks.check, { connectionId: row._id })).toMatchObject({ ok: true });

    fakeIntuit({ api: ["busy"] });
    const failed = await t.action(internal.quickbooks.check, { connectionId: row._id });
    expect(failed).toMatchObject({ ok: false, kind: "transient" });
    expect(failed.ok ? "" : failed.message).toMatch(/QuickBooks request tid-/);
    expect((await connections(t))[0].status).toBe("connected");
  });

  it("asks the Owner to reconnect when Intuit ends the authorization (invalid_grant), and reconnecting restores it", async () => {
    fakeIntuit({ refresh: ["invalid_grant"] });
    const { as, companyId } = await company(t, "owner-g", "Golf Cleaning");
    await connect(t, as, companyId);
    const [row] = await connections(t);
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(await t.action(internal.quickbooks.check, { connectionId: row._id })).toMatchObject({ ok: false, kind: "needs_reconnect" });
    expect((await connections(t))[0]).toMatchObject({ status: "needs_reconnect" });
    expect(await credentials(t)).toEqual([]);
    expect((await as.query(api.integrations.overview, { companyId })).live["quickbooks-online"]).toEqual({ state: "in_progress", detail: "Reconnect needed" });

    // Reconnecting the same QuickBooks company brings the same connection back.
    fakeIntuit();
    expect((await connect(t, as, companyId)).result).toBe("connected");
    const after = await connections(t);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ _id: row._id, status: "connected" });
    expect(await t.run((ctx) => ctx.db.query("events").filter((q) => q.eq(q.field("type"), "quickbooks.reconnected")).collect())).toHaveLength(1);
  });

  it("disconnects: revokes the authorization at Intuit and deletes the tokens", async () => {
    const calls = fakeIntuit();
    const { as, companyId } = await company(t, "owner-h", "Hotel Cleaning");
    await connect(t, as, companyId);
    const manager = await addMember(t, as, companyId, "manager-h", "manager");
    expect(await refusal(manager.mutation(api.quickbooks.disconnect, { companyId }))).toBe("Not allowed.");
    await as.mutation(api.quickbooks.disconnect, { companyId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const revoked = calls.find((call) => call.url.endsWith("/v2/oauth2/tokens/revoke"))!;
    expect(JSON.parse(revoked.body)).toEqual({ token: "refresh-1" });
    expect(revoked.auth).toBe(`Basic ${btoa("qbo-client-id:qbo-client-secret-not-real")}`);
    expect((await connections(t))[0]).toMatchObject({ status: "disconnected" });
    expect(await credentials(t)).toEqual([]);
    expect(await as.query(api.quickbooks.status, { companyId })).toMatchObject({ connection: null });
  });

  it("keeps Intuit's discovery document for the sign-in address and refreshes it in the background", async () => {
    const calls = fakeIntuit();
    const { as, companyId } = await company(t, "owner-i", "India Cleaning");
    await as.mutation(api.quickbooks.startConnect, { companyId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(calls.some((call) => call.url === "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration")).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("quickbooksDiscovery").collect())).toMatchObject([{ environment: "sandbox", authorization: "https://appcenter.intuit.com/connect/oauth2" }]);
  });
});
