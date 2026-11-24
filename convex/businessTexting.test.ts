/**
 * @vitest-environment edge-runtime
 *
 * Email & texting › Business texting: the eight states from real records, blockers with their next step,
 * which connection carries each agent, and the Owner's controlled test text. Mock provider.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchTestEnv, flush, setup } from "../tests/dispatchHarness";
import { company, start } from "../tests/harness";
import { api } from "./_generated/api";
import { mockOutbox } from "./lib/messaging/provider";
import { stateOf, type StateInput } from "./lib/texting/businessState";
import { describesSelestial } from "./textingSetup";

const base: StateInput = {
  request: null,
  setupStarted: false,
  messaging: { registration: { status: "not_started" } },
  company: { pausedAgents: [] },
  quo: null,
  outOfFunds: false,
};
const withRequest = (status: NonNullable<StateInput["request"]>["status"], extra: Partial<NonNullable<StateInput["request"]>> = {}): StateInput => ({ ...base, setupStarted: true, request: { status, phoneNumber: "+15125550100", ...extra } as NonNullable<StateInput["request"]> });
const ready: StateInput = { ...base, messaging: { smsNumber: "+15125550100", senderName: "Alpha", registration: { status: "approved" } } };

describe("Business texting states", () => {
  it("reads each state from the records, never from what an owner said", () => {
    expect(stateOf(base)).toBe("not_configured");
    expect(stateOf({ ...base, setupStarted: true })).toBe("setup_in_progress");
    expect(stateOf(withRequest("requested"))).toBe("submitted");
    expect(stateOf(withRequest("waiting_on_carriers"))).toBe("under_review");
    expect(stateOf(withRequest("provisioning", { campaignApprovedAt: 1 }))).toBe("approved");
    expect(stateOf(withRequest("needs_you"))).toBe("changes_needed");
    expect(stateOf(withRequest("rejected"))).toBe("changes_needed");
    expect(stateOf(withRequest("interrupted"))).toBe("sending_unavailable");
    expect(stateOf(withRequest("cancelled"))).toBe("setup_in_progress");
    expect(stateOf(ready)).toBe("ready");
    expect(stateOf({ ...ready, outOfFunds: true })).toBe("sending_unavailable");
    expect(stateOf({ ...ready, company: { pausedAgents: [], messagingPause: { at: 1, by: "m" as never } } })).toBe("sending_unavailable");
    // A paused agent limits, but doesn't stop, the company's texting.
    expect(stateOf({ ...ready, company: { pausedAgents: ["sales"] } })).toBe("ready");
    // A ready Quo connection used for new conversations can carry the company's texts on its own.
    expect(stateOf({ ...base, quo: { status: "ready", useForNew: true, selected: [{ id: "PN1", phoneNumber: "+15125550111" }] as never, agents: ["sales"] } })).toBe("ready");
  });

  it("never lets the company builder register Selestial itself", () => {
    expect(describesSelestial({ displayName: "Selestial", legalName: "Selestial Inc" })).toBe(true);
    expect(describesSelestial({ displayName: "Alpha Cleaning", website: "https://app.selestial.io/b/alpha" })).toBe(true);
    expect(describesSelestial({ displayName: "Novara Cleaning", legalName: "Novara LLC", website: "novara.example" })).toBe(false);
  });
});

describe("Business texting panel", () => {
  let undo = () => {};
  beforeEach(() => {
    undo = dispatchTestEnv();
    process.env.PLATFORM_SMS_CODES_FROM = "+18885550100";
    process.env.PLATFORM_SMS_CODES_PROFILE_ID = "profile-codes";
  });
  afterEach(() => {
    undo();
    for (const name of ["PLATFORM_SMS_CODES_FROM", "PLATFORM_SMS_CODES_PROFILE_ID", "MESSAGING_BILLING"]) delete process.env[name];
  });

  it("shows a company without texting as not configured, with the way in", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-new", "New Maids");
    const view = await as.query(api.businessTexting.overview, { companyId });
    expect(view).toMatchObject({ state: "not_configured", label: "Not configured", number: null, next: { label: "Set up business texting", href: "/app/texting" }, canTest: false });
    expect(view.routes.every((row) => row.via === "none")).toBe(true);
  });

  it("shows a ready company's number, routes and blockers, and the owner's pause", async () => {
    const s = await setup(["Lena"]);
    const view = await s.as.query(api.businessTexting.overview, { companyId: s.companyId });
    expect(view).toMatchObject({ state: "ready", label: "Ready to send", number: s.smsNumber, provider: { selestial: true, quo: null }, blockers: [], canTest: true });
    expect(view.routes.map((row) => row.via)).toEqual(["selestial", "selestial", "selestial", "selestial", "selestial"]);
    await s.as.mutation(api.companies.pauseMessaging, { companyId: s.companyId });
    const paused = await s.as.query(api.businessTexting.overview, { companyId: s.companyId });
    expect(paused).toMatchObject({ state: "sending_unavailable", paused: { reason: null } });
    expect(paused.blockers.map((row) => row.key)).toEqual(["paused"]);
  });

  it("sends the owner's test text only to their own confirmed phone, through the normal path, free", async () => {
    const s = await setup(["Lena"]);
    process.env.MESSAGING_BILLING = "on";
    await expect(s.as.mutation(api.businessTexting.sendTest, { companyId: s.companyId })).rejects.toThrow(/Confirm your own phone/);
    await s.as.mutation(api.myPhone.start, { phone: "+15125550166" });
    await flush(s.t);
    const code = /(\d{6})/.exec(mockOutbox.find((row) => row.to === "+15125550166")!.body)![1];
    await s.as.mutation(api.myPhone.confirm, { code });
    const sent = await s.as.mutation(api.businessTexting.sendTest, { companyId: s.companyId });
    expect(sent).toMatchObject({ last4: "0166" });
    await flush(s.t);
    const test = mockOutbox.filter((row) => row.from === s.smsNumber && row.to === "+15125550166");
    expect(test).toHaveLength(1);
    expect(test[0].body).toContain("this is a test text from your business number");
    expect(await s.t.run(async (ctx) => (await ctx.db.query("messagingCharges").collect()).filter((row) => row.messageId === sent.messageId && row.amount > 0))).toHaveLength(0);
  });
});
