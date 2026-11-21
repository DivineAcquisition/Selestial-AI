/**
 * @vitest-environment edge-runtime
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { refusal, start, type T } from "../tests/harness";
import { ADMIN, REVIEWER } from "../tests/trustHarness";
import { api } from "./_generated/api";

type Call = { method: string; path: string; body: Record<string, unknown> | null };

/** Telnyx as the check sees it. `brandReadyAfter` checks before the mock brand reads as verified. */
function fakeTelnyx(options: { keyOk?: boolean; webhookUrl?: string; brandReadyAfter?: number } = {}) {
  const calls: Call[] = [];
  let brandChecks = 0;
  const campaigns: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname).replace("/v2", "");
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, body });
    if (options.keyOk === false) return json({ errors: [{ code: "10009", title: "Authentication failed" }] }, 401);
    if (method === "GET" && path === "/10dlc/brand") return json({ records: [], page: 1, totalRecords: 2 });
    if (method === "GET" && path === "/messaging_profiles/profile-1") return json({ data: { id: "profile-1", name: "Selestial", enabled: true, webhook_url: options.webhookUrl ?? "https://deployment.convex.site.test/webhooks/telnyx", v1_secret: "never-read" } });
    if (method === "GET" && path === "/available_phone_numbers") return json({ data: [{ phone_number: "+15125550142", features: [{ name: "sms" }] }] });
    if (method === "POST" && path === "/10dlc/brand") return json({ brandId: "mock-brand-1", identityStatus: null, status: "REGISTRATION_PENDING" });
    if (method === "GET" && path === "/10dlc/brand/mock-brand-1") {
      brandChecks += 1;
      return json({ brandId: "mock-brand-1", identityStatus: brandChecks > (options.brandReadyAfter ?? 0) ? "VERIFIED" : "SELF_DECLARED", status: "OK" });
    }
    if (method === "POST" && path === "/10dlc/campaignBuilder") {
      if (brandChecks <= (options.brandReadyAfter ?? 0)) return json({ errors: [{ code: "10015", title: "Brand is not verified" }] }, 400);
      campaigns.push(`mock-campaign-${campaigns.length + 1}`);
      return json({ campaignId: campaigns[campaigns.length - 1], campaignStatus: "TCR_ACCEPTED", referenceId: body?.referenceId });
    }
    if (method === "GET" && path.startsWith("/10dlc/campaign/")) return json({ campaignId: path.split("/")[3], campaignStatus: "TCR_ACCEPTED", referenceId: "ref" });
    if (method === "GET" && path === "/10dlc/campaign") return json({ records: campaigns.map((campaignId) => ({ campaignId })), page: 1 });
    if (method === "DELETE") return json({});
    return json({ errors: [{ code: "10005", title: "Resource not found" }] }, 404);
  };
  return { fetcher, calls };
}

async function runCheck(t: T) {
  const admin = t.withIdentity(ADMIN);
  await admin.mutation(api.telnyxCheck.run, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return (await admin.query(api.telnyxCheck.latest, {}))[0];
}

describe("Staff Telnyx check", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.TELNYX_API_KEY = "KEY_test";
    process.env.TELNYX_PUBLIC_KEY = "public-key";
    process.env.TELNYX_MESSAGING_PROFILE_ID = "profile-1";
    process.env.TELNYX_WEBHOOK_URL = "https://deployment.convex.site.test";
    process.env.STAFF_BOOTSTRAP_EMAIL = ADMIN.email;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const name of ["TELNYX_API_KEY", "TELNYX_PUBLIC_KEY", "TELNYX_MESSAGING_PROFILE_ID", "TELNYX_WEBHOOK_URL", "STAFF_BOOTSTRAP_EMAIL"]) delete process.env[name];
  });

  it("checks the account, files a mock brand and campaign through the real submission code, and removes them", async () => {
    const telnyx = fakeTelnyx();
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const check = await runCheck(t);
    expect(check.status).toBe("passed");
    expect(check.steps.map((row) => [row.key, row.state])).toEqual([
      ["key", "passed"],
      ["profile", "passed"],
      ["callbacks", "passed"],
      ["signing", "passed"],
      ["numbers", "passed"],
      ["brand", "passed"],
      ["brand-read", "passed"],
      ["campaign", "passed"],
      ["campaign-read", "passed"],
      ["cleanup-campaign", "passed"],
      ["cleanup-brand", "passed"],
    ]);
    // Only mock filings, and no number is bought or connected.
    const writes = telnyx.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);
    expect(writes).toEqual(["POST /10dlc/brand", "POST /10dlc/campaignBuilder", "DELETE /10dlc/campaign/mock-campaign-1", "DELETE /10dlc/brand/mock-brand-1"]);
    const brand = telnyx.calls.find((call) => call.method === "POST" && call.path === "/10dlc/brand")!.body!;
    expect(brand).toMatchObject({ mock: true, entityType: "PRIVATE_PROFIT", ein: "12-3456789", webhookURL: "https://deployment.convex.site.test/webhooks/telnyx" });
    const campaign = telnyx.calls.find((call) => call.path === "/10dlc/campaignBuilder")!.body!;
    expect(campaign).toMatchObject({ brandId: "mock-brand-1", usecase: "MIXED", subUsecases: ["CUSTOMER_CARE", "ACCOUNT_NOTIFICATION"] });
    expect(String(campaign.privacyPolicyLink)).toMatch(/\/b\/selestial-check\/legal\/privacy$/);
    expect(String(campaign.messageFlow).length).toBeGreaterThanOrEqual(40);
    expect(JSON.stringify(check)).not.toContain("never-read");
  });

  it("stops at the key when Telnyx refuses it, and files nothing", async () => {
    const telnyx = fakeTelnyx({ keyOk: false });
    vi.stubGlobal("fetch", telnyx.fetcher);
    const check = await runCheck(start());
    expect(check.status).toBe("failed");
    expect(check.steps.map((row) => [row.key, row.state])).toEqual([
      ["key", "failed"],
      ["mock", "skipped"],
    ]);
    expect(telnyx.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("warns when the messaging profile sends texts elsewhere, and waits for a mock brand still being verified", async () => {
    const telnyx = fakeTelnyx({ webhookUrl: "https://old.example.test/hooks", brandReadyAfter: 2 });
    vi.stubGlobal("fetch", telnyx.fetcher);
    const check = await runCheck(start());
    expect(check.steps.find((row) => row.key === "profile")).toMatchObject({ state: "warning", detail: expect.stringContaining("https://old.example.test/hooks") });
    expect(check.steps.find((row) => row.key === "campaign")).toMatchObject({ state: "passed" });
    // The campaign was tried while the brand was being verified, then filed once it was.
    expect(telnyx.calls.filter((call) => call.path === "/10dlc/campaignBuilder").length).toBe(3);
    expect(check.status).toBe("passed");
  });

  it("is for admins only, one at a time", async () => {
    vi.stubGlobal("fetch", fakeTelnyx().fetcher);
    const t = start();
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.staff.add, { email: REVIEWER.email, name: REVIEWER.name, role: "reviewer" });
    expect(await refusal(t.withIdentity(REVIEWER).mutation(api.telnyxCheck.run, {}))).toBe("Not allowed.");
    await admin.mutation(api.telnyxCheck.run, {});
    expect(await refusal(admin.mutation(api.telnyxCheck.run, {}))).toContain("already running");
    expect(await refusal(t.withIdentity({ subject: "someone", issuer: "https://clerk.test" }).query(api.telnyxCheck.latest, {}))).toBe("Not found.");
  });
});
