/**
 * @vitest-environment edge-runtime
 *
 * Selestial's own Telnyx account, checked hourly with a read-only call (convex/providerHealth.ts) and turned
 * into an incident by the provider_health check. Telnyx is stubbed; nothing is sent.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { start, type T } from "../tests/harness";
import { internal } from "./_generated/api";

const run = (t: T) => t.mutation(internal.operations.runCheck, { check: "provider_health" });
const open = (t: T) => t.run(async (ctx) => (await ctx.db.query("incidents").collect()).filter((row) => row.check === "provider_health" && !row.resolvedAt).map((row) => ({ kind: row.kind, severity: row.severity })));
let answer: () => Response = () => new Response("{}");

describe("Provider health", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEY_test";
    vi.stubGlobal("fetch", async (url: string) => {
      expect(String(url)).toBe("https://api.telnyx.com/v2/balance");
      return answer();
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_BALANCE_ALERT_DOLLARS;
  });

  test("opens a critical incident when Telnyx refuses the key, and clears it when the key works again", async () => {
    const t = start();
    answer = () => new Response(JSON.stringify({ errors: [{ code: "10009", title: "Authentication failed" }] }), { status: 401 });
    await t.action(internal.providerHealth.probe, {});
    await run(t);
    expect(await open(t)).toEqual([{ kind: "telnyx_key_refused", severity: "critical" }]);
    answer = () => new Response(JSON.stringify({ data: { balance: "120.00", available_credit: "120.00", currency: "USD" } }), { status: 200 });
    await t.action(internal.providerHealth.probe, {});
    await run(t);
    expect(await open(t)).toEqual([]);
  });

  test("warns when the account is running out of money, critically under $10", async () => {
    const t = start();
    answer = () => new Response(JSON.stringify({ data: { balance: "22.50", currency: "USD" } }), { status: 200 });
    await t.action(internal.providerHealth.probe, {});
    await run(t);
    expect(await open(t)).toEqual([{ kind: "telnyx_balance_low", severity: "high" }]);
    answer = () => new Response(JSON.stringify({ data: { balance: "4.00", currency: "USD" } }), { status: 200 });
    await t.action(internal.providerHealth.probe, {});
    await run(t);
    expect(await open(t)).toEqual([{ kind: "telnyx_balance_low", severity: "critical" }]);
    // The floor is a setting; above it, nothing is open.
    process.env.TELNYX_BALANCE_ALERT_DOLLARS = "3";
    await run(t);
    expect(await open(t)).toEqual([]);
  });

  test("waits for two unanswered checks before calling Telnyx unreachable, and never calls Telnyx without a key", async () => {
    const t = start();
    answer = () => new Response("bad gateway", { status: 502 });
    await t.action(internal.providerHealth.probe, {});
    await run(t);
    expect(await open(t)).toEqual([]);
    await t.action(internal.providerHealth.probe, {});
    await run(t);
    expect(await open(t)).toEqual([{ kind: "telnyx_unreachable", severity: "high" }]);
    delete process.env.TELNYX_API_KEY;
    const before = await t.run(async (ctx) => (await ctx.db.query("opsSignals").collect()).length);
    await t.action(internal.providerHealth.probe, {});
    expect(await t.run(async (ctx) => (await ctx.db.query("opsSignals").collect()).length)).toBe(before);
  });
});
