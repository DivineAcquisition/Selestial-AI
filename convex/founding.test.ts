/**
 * @vitest-environment edge-runtime
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { company, NOW, refusal, start, staffWith, type T } from "../tests/harness";
import { billing } from "../tests/setupBilling";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { EARLY_OFFER } from "./lib/billing/catalog";
import { NOT_FOUND } from "./lib/errors";
import { checkedAttribution, DAY_MS, enrollmentState, FOUNDING_OFFER, remaining, windowFrom } from "./lib/founding/offer";

const secret = "test-secret-value";
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const sync = (t: T, companyId: Id<"companies">) => t.action(internal.billing.syncCompany, { companyId });
const STAFF = { subject: "staff-1", email: "ops@selestial.io", name: "Ops" };
const answers = { companyName: "Sparkle Co", currentSoftware: "jobber", teamSize: "6-15", priority: "bookings" };
let keys = 0;
const newKey = () => `claimkey_${String((keys += 1)).padStart(4, "0")}_abcdefghijklmnopqrstu`;

async function staff(t: T) {
  await staffWith(t, STAFF, ["billing.adjust"]);
  return t.withIdentity({ ...STAFF, emailVerified: true, issuer: "https://clerk.selestial.test", tokenIdentifier: `https://clerk.selestial.test|${STAFF.subject}` });
}
const open = async (t: T) => (await staff(t)).mutation(api.founding.activate, { confirmVersion: FOUNDING_OFFER.version });
const claim = (t: T, claimKey = newKey(), extra: Partial<typeof answers> = {}) => t.mutation(api.founding.startClaim, { secret, claimKey, ...answers, ...extra, visitorKey: "visitor-1" });

async function fresh(t: T, subject: string, name: string) {
  const c = await company(t, subject, name);
  billing.seed(c.companyId, { plan: null, cardOnFile: true });
  await sync(t, c.companyId);
  return c;
}
async function buy(t: T, c: Awaited<ReturnType<typeof fresh>>) {
  const intentId = await c.as.mutation(api.billing.startPlanChange, { companyId: c.companyId, plan: "operate" });
  await settle(t);
  await c.as.mutation(api.billing.confirmIntent, { companyId: c.companyId, intentId });
  await settle(t);
  return intentId;
}
const foundingNotices = (t: T, companyId: Id<"companies">) => t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((row) => row.companyId === companyId && row.notice?.event === "founding_claimed"));

describe("the founding offer, as data", () => {
  it("is the billing rule's own terms, not new ones", () => {
    expect(FOUNDING_OFFER.billing).toMatchObject({ autumnPlanId: "operate_early", renewsOntoAutumnPlanId: "operate", foundingMonthlyCents: 199_00, foundingMonths: 12, renewalMonthlyCents: 299_00, trial: false });
    expect(FOUNDING_OFFER.capacity).toBe(EARLY_OFFER.places);
    expect(FOUNDING_OFFER.bonusAgents).toEqual(["quality"]);
  });

  it("decides the window from stored timestamps and the caller's clock only", () => {
    const window = windowFrom(NOW);
    expect(window.enrollmentEndsAt - window.enrollmentStartsAt).toBe(90 * DAY_MS);
    const campaign = { status: "open" as const, ...window };
    expect(enrollmentState(null, 0, NOW)).toBe("not_open");
    expect(enrollmentState({ status: "draft" }, 0, NOW)).toBe("not_open");
    expect(enrollmentState(campaign, 0, NOW - 1)).toBe("not_open");
    expect(enrollmentState(campaign, 0, NOW)).toBe("open");
    expect(enrollmentState(campaign, FOUNDING_OFFER.capacity - 1, window.enrollmentEndsAt - 1)).toBe("open");
    expect(enrollmentState(campaign, FOUNDING_OFFER.capacity, NOW)).toBe("closed_full");
    expect(enrollmentState(campaign, 0, window.enrollmentEndsAt)).toBe("closed_deadline");
    expect(enrollmentState({ ...campaign, status: "closed" }, 0, NOW)).toBe("closed");
  });

  it("counts down calmly and stops at zero", () => {
    expect(remaining(NOW + 2 * DAY_MS + 3 * 3_600_000 + 4 * 60_000 + 59_000, NOW)).toEqual({ days: 2, hours: 3, minutes: 4, done: false });
    expect(remaining(NOW - 5000, NOW)).toEqual({ days: 0, hours: 0, minutes: 0, done: true });
  });

  it("keeps only plain UTM values", () => {
    expect(checkedAttribution({ source: "Google", medium: "cpc", campaign: "founding-nov" })).toEqual({ source: "google", medium: "cpc", campaign: "founding-nov" });
    expect(checkedAttribution({ source: "dana@example.com", medium: "a b", campaign: "x".repeat(80) })).toEqual({});
  });
});

describe("founding enrollment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("PUBLIC_FORM_SECRET", secret);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("is opened once, by staff with billing rights, for exactly 90 days, and can't be restarted", async () => {
    const t = start();
    const owner = await company(t, "owner-a", "Alpha Cleaning");
    expect(await refusal(owner.as.mutation(api.founding.activate, { confirmVersion: FOUNDING_OFFER.version }))).toBe(NOT_FOUND);
    const ops = await staff(t);
    expect(await refusal(ops.mutation(api.founding.activate, { confirmVersion: "old" }))).toMatch(/Confirm the offer version/);
    const window = await ops.mutation(api.founding.activate, { confirmVersion: FOUNDING_OFFER.version });
    expect(window.enrollmentEndsAt - window.enrollmentStartsAt).toBe(90 * DAY_MS);
    expect(Math.abs(window.enrollmentStartsAt - NOW)).toBeLessThan(1000);
    // A later call, a deploy or a page load cannot move it.
    vi.setSystemTime(NOW + 10 * DAY_MS);
    expect(await refusal(ops.mutation(api.founding.activate, { confirmVersion: FOUNDING_OFFER.version }))).toMatch(/already opened/);
    const status = await t.query(api.founding.status, {});
    expect(status.campaign).toEqual({ status: "open", ...window, displayTimezone: FOUNDING_OFFER.displayTimezone });
  });

  it("won't open while the founding price can't be paid", async () => {
    const t = start();
    vi.stubEnv("EARLY_OFFER", "");
    expect(await refusal(open(t))).toMatch(/can't be paid yet/);
    expect((await t.query(api.founding.status, {})).campaign).toBeNull();
  });

  it("starts claims only while enrollment is open, once per key", async () => {
    const t = start();
    expect(await claim(t)).toEqual({ status: "closed" });
    const window = await open(t);
    expect(await claim(t, newKey(), { teamSize: "a lot" })).toEqual({ status: "invalid" });
    expect(await refusal(t.mutation(api.founding.startClaim, { secret: "wrong-secret-value", claimKey: newKey(), ...answers, visitorKey: "v" }))).toMatch(/Not found/);
    const key = newKey();
    expect(await claim(t, key)).toEqual({ status: "started", claimKey: key });
    expect(await claim(t, key)).toEqual({ status: "started", claimKey: key });
    expect(await t.run(async (ctx) => (await ctx.db.query("foundingClaims").collect()).length)).toBe(1);
    expect(await t.query(internal.founding.claimOf, { claimKey: key })).toMatchObject({ ...answers, offerVersion: FOUNDING_OFFER.version });
    vi.setSystemTime(window.enrollmentEndsAt - 1);
    expect((await claim(t)).status).toBe("started");
    vi.setSystemTime(window.enrollmentEndsAt);
    expect(await claim(t)).toEqual({ status: "closed" });
  });

  it("takes a claim through company setup, checkout and a verified payment, and counts it once", async () => {
    const t = start();
    await open(t);
    const key = newKey();
    await claim(t, key);
    const a = await fresh(t, "owner-a", "Alpha Cleaning");
    // Company setup starts from the claim's name, for the person it is bound to only.
    expect(await a.as.query(api.founding.claimPreview, { claimKey: key })).toEqual({ companyName: "Sparkle Co" });
    await a.as.mutation(api.founding.attachClaim, { companyId: a.companyId, claimKey: key });
    await a.as.mutation(api.founding.attachClaim, { companyId: a.companyId, claimKey: key });
    const other = await company(t, "owner-b", "Beta Cleaning");
    expect(await other.as.query(api.founding.claimPreview, { claimKey: key })).toBeNull();
    expect(await refusal(other.as.mutation(api.founding.attachClaim, { companyId: other.companyId, claimKey: key }))).toMatch(/not found/);
    expect((await t.run((ctx) => ctx.db.get(a.companyId)))!.foundingProfile).toEqual({ currentSoftware: "jobber", teamSize: "6-15", priority: "bookings", offerVersion: FOUNDING_OFFER.version });

    expect((await a.as.query(api.founding.mine, { companyId: a.companyId })).step).toEqual({ kind: "ready_to_pay", placesLeft: EARLY_OFFER.places });
    // A started account is not a founding customer.
    expect((await t.query(api.founding.status, {})).joined).toBe(0);

    await buy(t, a);
    const row = (await t.query(internal.founding.offerRowOf, { companyId: a.companyId, env: "sandbox" }))!;
    expect(row).toMatchObject({ state: "claimed", offerVersion: FOUNDING_OFFER.version });
    expect((await a.as.query(api.founding.mine, { companyId: a.companyId })).step).toMatchObject({ kind: "claimed", endsAt: row.offerEndsAt });
    // Repeated and late billing events change nothing: one company, one notice.
    await sync(t, a.companyId);
    await sync(t, a.companyId);
    await settle(t);
    expect((await t.query(api.founding.status, {})).joined).toBe(1);
    expect(await foundingNotices(t, a.companyId)).toHaveLength(1);

    const funnel = await (await staff(t)).query(api.founding.funnel, {});
    expect(funnel).toMatchObject({ leads: 1, accounts: 1, checkoutsStarted: 1, verifiedClaims: 1, activeSubscriptions: 1 });
  });

  it("leaves reservations, failed checkouts and staff-marked test companies out of the public count", async () => {
    const t = start();
    await open(t);
    const a = await fresh(t, "owner-a", "Alpha Cleaning");
    const b = await fresh(t, "owner-b", "Demo Cleaning");
    await buy(t, a);
    await buy(t, b);
    await (await staff(t)).mutation(api.founding.setExcludedFromCounts, { companyId: b.companyId, excluded: true });
    await t.run(async (ctx) => {
      const filler = (await ctx.db.query("companies").first())!._id;
      await ctx.db.insert("earlyOffers", { companyId: filler, env: "sandbox", state: "reserved", reservedAt: NOW, reservedUntil: NOW + DAY_MS, updatedAt: NOW });
      await ctx.db.insert("earlyOffers", { companyId: filler, env: "sandbox", state: "released", reservedAt: NOW, reservedUntil: NOW, updatedAt: NOW });
      // A production row never reaches a sandbox count, and the other way round.
      await ctx.db.insert("earlyOffers", { companyId: filler, env: "production", state: "claimed", reservedAt: NOW, reservedUntil: NOW, claimedAt: NOW, updatedAt: NOW });
    });
    const status = await t.query(api.founding.status, {});
    expect(status.joined).toBe(1);
    // Places left follow the billing rule exactly: both paid places and the live reservation are used.
    expect(status.placesUsed).toBe(3);
  });

  it("shows no number at all when billing isn't connected", async () => {
    const t = start();
    vi.stubEnv("AUTUMN_SECRET_KEY", "");
    const status = await t.query(api.founding.status, {});
    expect(status).toMatchObject({ joined: null, placesUsed: null, checkoutOn: false });
  });

  it("refuses the founding price on the server after the deadline, even mid-checkout", async () => {
    const t = start();
    const { enrollmentEndsAt } = await open(t);
    const a = await fresh(t, "owner-a", "Alpha Cleaning");
    // Previewed at the founding price just before the deadline…
    vi.setSystemTime(enrollmentEndsAt - 5 * 60_000);
    const intentId = await a.as.mutation(api.billing.startPlanChange, { companyId: a.companyId, plan: "operate" });
    await settle(t);
    expect(await a.as.query(api.billing.intent, { companyId: a.companyId, intentId })).toMatchObject({ offer: "early" });
    // …and confirmed after it: nothing is sent at $199; the full price is shown again before any charge.
    vi.setSystemTime(enrollmentEndsAt + 60_000);
    await a.as.mutation(api.billing.confirmIntent, { companyId: a.companyId, intentId });
    await settle(t);
    expect(await a.as.query(api.billing.intent, { companyId: a.companyId, intentId })).toMatchObject({ offer: null, stage: "awaiting_confirmation" });
    expect(billing.state.calls.filter((call) => call.path === "/v1/billing.attach")).toEqual([]);
    expect(await t.query(internal.founding.offerRowOf, { companyId: a.companyId, env: "sandbox" })).toBeNull();
    expect((await a.as.query(api.founding.mine, { companyId: a.companyId })).step).toEqual({ kind: "not_eligible", reason: "enrollment_closed" });
    // A new purchase is simply Operate.
    const late = await fresh(t, "owner-c", "Late Cleaning");
    const lateIntent = await late.as.mutation(api.billing.startPlanChange, { companyId: late.companyId, plan: "operate" });
    await settle(t);
    expect(await late.as.query(api.billing.intent, { companyId: late.companyId, intentId: lateIntent })).toMatchObject({ offer: null });
  });

  it("honours a place reserved before the deadline, and keeps a founding customer's terms after it", async () => {
    const t = start();
    await open(t);
    const a = await fresh(t, "owner-a", "Alpha Cleaning");
    await buy(t, a);
    const before = (await t.query(internal.founding.offerRowOf, { companyId: a.companyId, env: "sandbox" }))!;
    vi.setSystemTime(NOW + 120 * DAY_MS);
    await sync(t, a.companyId);
    const after = (await t.query(internal.founding.offerRowOf, { companyId: a.companyId, env: "sandbox" }))!;
    expect(after).toMatchObject({ state: "claimed", offerEndsAt: before.offerEndsAt });
    expect((await a.as.query(api.founding.mine, { companyId: a.companyId })).step).toMatchObject({ kind: "claimed" });
  });

  it("closes early when staff close it, and says not open before any activation", async () => {
    const t = start();
    const a = await fresh(t, "owner-a", "Alpha Cleaning");
    expect((await a.as.query(api.founding.mine, { companyId: a.companyId })).step).toMatchObject({ kind: "ready_to_pay" });
    await open(t);
    await (await staff(t)).mutation(api.founding.close, { reason: "All onboarding slots are booked." });
    expect(await claim(t)).toEqual({ status: "closed" });
    expect((await a.as.query(api.founding.mine, { companyId: a.companyId })).step).toEqual({ kind: "not_eligible", reason: "enrollment_closed" });
  });
});
