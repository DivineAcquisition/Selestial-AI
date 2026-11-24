/**
 * @vitest-environment edge-runtime
 *
 * Selestial's notices to the people who run a company, by text (My notifications): their own phone,
 * confirmed with a code; texts only for categories they turned on; quiet hours; Selestial pays.
 * Mock provider; nothing is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchTestEnv, flush, setup } from "../tests/dispatchHarness";
import { api } from "./_generated/api";
import { mockOutbox } from "./lib/messaging/provider";
import { notifyMembers } from "./lib/notify/route";

const CODES_FROM = "+18885550100";
const NOTICES_FROM = "+18885550101";
const MINE = "+15125550166";

type S = Awaited<ReturnType<typeof setup>>;

async function confirmPhone(s: S) {
  await s.as.mutation(api.myPhone.start, { phone: MINE });
  await flush(s.t);
  const text = mockOutbox.find((row) => row.from === CODES_FROM && row.to === MINE)!;
  const code = /(\d{6})/.exec(text.body)![1];
  return s.as.mutation(api.myPhone.confirm, { code });
}
const textsTo = (to: string) => mockOutbox.filter((row) => row.from === NOTICES_FROM && row.to === to);

describe("My notifications by text", () => {
  let undo = () => {};
  beforeEach(() => {
    undo = dispatchTestEnv();
    process.env.PLATFORM_SMS_CODES_FROM = CODES_FROM;
    process.env.PLATFORM_SMS_CODES_PROFILE_ID = "profile-codes";
    process.env.PLATFORM_SMS_NOTICES_FROM = NOTICES_FROM;
    process.env.PLATFORM_SMS_NOTICES_PROFILE_ID = "profile-notices";
  });
  afterEach(() => {
    undo();
    for (const name of ["PLATFORM_SMS_CODES_FROM", "PLATFORM_SMS_CODES_PROFILE_ID", "PLATFORM_SMS_NOTICES_FROM", "PLATFORM_SMS_NOTICES_PROFILE_ID", "MESSAGING_BILLING"]) delete process.env[name];
  });

  it("confirms the person's own phone with a code, never storing the code", async () => {
    const s = await setup(["Lena"]);
    expect(await s.as.query(api.myPhone.mine, {})).toMatchObject({ phoneLast4: null, available: true });
    await expect(s.as.mutation(api.myPhone.start, { phone: "+14165550123" })).rejects.toThrow(/US mobile/);
    expect(await confirmPhone(s)).toEqual({ last4: "0166" });
    expect(await s.as.query(api.myPhone.mine, {})).toMatchObject({ phoneLast4: "0166", pending: null });
    const stored = await s.t.run(async (ctx) => JSON.stringify(await ctx.db.query("platformMessages").collect()) + JSON.stringify(await ctx.db.query("userPhones").collect()));
    const code = /(\d{6})/.exec(mockOutbox.find((row) => row.to === MINE)!.body)![1];
    expect(stored).not.toContain(code);
  });

  it("texts only categories the person turned on, waits out their quiet hours, and charges the company nothing", async () => {
    const s = await setup(["Lena"]);
    process.env.MESSAGING_BILLING = "on";
    await confirmPhone(s);
    // Off by default: nothing is texted.
    await s.t.run(async (ctx) => notifyMembers(ctx, { companyId: s.companyId, event: "approval_needed", ref: "a1" }));
    await flush(s.t);
    expect(textsTo(MINE)).toHaveLength(0);
    // Activity can't come by text.
    await expect(s.as.mutation(api.notifications.setText, { companyId: s.companyId, category: "activity", on: true })).rejects.toThrow(/email only/);
    await s.as.mutation(api.notifications.setText, { companyId: s.companyId, category: "approvals", on: true });
    // Quiet hours that cover now: an approval (high, not critical) waits until they end.
    await s.as.mutation(api.notifications.setTextQuiet, { companyId: s.companyId, start: "00:00", end: "23:59" });
    await s.t.run(async (ctx) => notifyMembers(ctx, { companyId: s.companyId, event: "approval_needed", ref: "a2" }));
    await flush(s.t);
    expect(textsTo(MINE)).toHaveLength(0);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    await flush(s.t);
    expect(textsTo(MINE)).toEqual([expect.objectContaining({ body: expect.stringMatching(/^Selestial · Alpha Cleaning: an agent is waiting for your approval\./) })]);
    // The same notice again is not texted twice.
    await s.t.run(async (ctx) => notifyMembers(ctx, { companyId: s.companyId, event: "approval_needed", ref: "a2" }));
    await flush(s.t);
    expect(textsTo(MINE)).toHaveLength(1);
    expect(await s.t.run(async (ctx) => (await ctx.db.query("messagingCharges").collect()).length)).toBe(0);
    const view = await s.as.query(api.notifications.mine, { companyId: s.companyId });
    expect(view.categories.find((row) => row.category === "approvals")).toMatchObject({ text: true, textable: true });
    expect(view.categories.find((row) => row.category === "activity")).toMatchObject({ text: false, textable: false });
  });
});
