/**
 * @vitest-environment edge-runtime
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, dispatchCleaner, refusal, start } from "../tests/harness";
import { ADMIN } from "../tests/trustHarness";
import { billing } from "../tests/setupBilling";
import { api, internal } from "./_generated/api";
import { classify } from "./inbound";
import { linkOrigin, NO_LINK_ORIGIN, siteOrigin } from "./lib/dispatch/links";
import { PRODUCTION_DEPLOYMENTS } from "./lib/environment";
import { campaignFor } from "./lib/messaging/campaign";
import { draftFor, draftGaps } from "./lib/texting/drafts";
import { openPlanCancelledWork, PORT_OUT_WORDING, RELEASE_WORDING } from "./lib/texting/offboarding";
import { planFor } from "./lib/texting/plan";
import { fakeTelnyx, KEY, NUMBER, OTHER, prepare, revision, settle, submit } from "../tests/textingHarness";

describe("Set up business texting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.TELNYX_API_KEY = "KEY_test";
    process.env.MAILBOX_TOKEN_KEY = KEY;
    process.env.STAFF_BOOTSTRAP_EMAIL = ADMIN.email;
    process.env.TELNYX_WEBHOOK_URL = "https://deployment.convex.site.test";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const name of ["TELNYX_API_KEY", "MAILBOX_TOKEN_KEY", "STAFF_BOOTSTRAP_EMAIL", "TELNYX_WEBHOOK_URL", "MESSAGING_BILLING"]) delete process.env[name];
  });

  it("opens one saved setup, prefilled with where each detail came from, and resumes it after a reload", async () => {
    vi.stubGlobal("fetch", fakeTelnyx().fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await as.mutation(api.compliance.updateIdentity, { companyId, legalName: "Alpha Cleaning LLC", address: { line1: "1 Main St", city: "Austin", region: "TX", postalCode: "78701", country: "US" }, supportEmail: "help@alpha.example" });
    const first = await as.mutation(api.textingSetup.open, { companyId });
    expect(await as.mutation(api.textingSetup.open, { companyId })).toBe(first);
    const view = (await as.query(api.textingSetup.view, { companyId }))!;
    expect(view.setup.step).toBe("business");
    expect(view.setup.business).toMatchObject({ displayName: "Alpha Cleaning", legalName: "Alpha Cleaning LLC", street: "1 Main St", city: "Austin", state: "TX", postalCode: "78701", supportEmail: "help@alpha.example" });
    expect(view.sources.find((row) => row.field === "street")).toMatchObject({ source: "profile", confirmed: false });
    expect(view.setup.notes.map((note) => note.words)).toContain("I filled in your business address from your company profile. Please confirm it matches your registration records.");
    expect(view.sources.find((row) => row.field === "displayName")).toMatchObject({ confirmed: false });
    // Selestial says what it did, and only that.
    expect(view.setup.notes.some((note) => /^I filled in your business name from/.test(note.words))).toBe(true);
    expect(view.setup.notes.some((note) => /Professional services/.test(note.words))).toBe(true);

    // Confirming and moving on is saved; a stale revision is refused rather than overwriting.
    const r1 = await revision(as, companyId);
    await as.mutation(api.textingSetup.save, { companyId, revision: r1, confirm: ["displayName"], step: "activities" });
    expect(await refusal(as.mutation(api.textingSetup.save, { companyId, revision: r1, step: "number" }))).toContain("another window");
    const again = (await as.query(api.textingSetup.view, { companyId }))!;
    expect(again.setup.step).toBe("activities");
    expect(again.sources.find((row) => row.field === "displayName")?.confirmed).toBe(true);

    // Only the owner can see or change it.
    const manager = await addMember(t, as, companyId, "manager-1", "manager");
    expect(await refusal(manager.query(api.textingSetup.view, { companyId }))).toBe("Not allowed.");
    expect(await refusal(manager.mutation(api.textingSetup.save, { companyId, revision: await revision(as, companyId), step: "number" }))).toBe("Not allowed.");
  });

  it("seals the EIN and only ever shows its last four digits", async () => {
    vi.stubGlobal("fetch", fakeTelnyx().fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await as.mutation(api.textingSetup.open, { companyId });
    expect(await refusal(as.mutation(api.textingSetup.setTaxId, { companyId, revision: await revision(as, companyId), taxId: "123" }))).toContain("9 digits");
    await as.mutation(api.textingSetup.setTaxId, { companyId, revision: await revision(as, companyId), taxId: "12-3456789" });
    const view = (await as.query(api.textingSetup.view, { companyId }))!;
    expect(view.setup.taxIdLast4).toBe("6789");
    expect(JSON.stringify(view)).not.toContain("123456789");
    const stored = await t.run(async (ctx) => ({ setups: await ctx.db.query("textingSetups").collect(), events: await ctx.db.query("events").collect() }));
    expect(JSON.stringify(stored)).not.toContain("123456789");
    expect(stored.setups[0].taxId?.sealed).toBeTruthy();
    // Without the key, nothing is stored in the clear: it is refused.
    delete process.env.MAILBOX_TOKEN_KEY;
    expect(await refusal(as.mutation(api.textingSetup.setTaxId, { companyId, revision: await revision(as, companyId), taxId: "98-7654321" }))).toContain("can't store your EIN securely");
  });

  it("drafts the company's own pages and wording, keeps the owner's edits, and records sign-ups against the exact version shown", async () => {
    vi.stubGlobal("fetch", fakeTelnyx().fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await prepare(t, as, companyId);
    const view = (await as.query(api.textingSetup.view, { companyId }))!;
    expect(view.drafts.every((row) => row.gaps.length === 0)).toBe(true);
    expect(view.setup.drafts.privacy.text).toContain("Alpha Cleaning LLC (doing business as Alpha Cleaning)");
    expect(view.setup.drafts.privacy.text).toMatch(/do not sell or share your mobile phone number/);
    expect(view.setup.drafts.marketing_consent.text).toContain("offers and promotions");
    expect(view.setup.drafts.sms_consent.text).not.toMatch(/promotion|offer/);
    // The company's own pages, on its own public address. Never Selestial's policy.
    const links = Object.fromEntries(view.pages.map((row) => [row.kind, row.url]));
    expect(links.privacy).toMatch(/\/b\/alpha-cleaning\/legal\/privacy$/);
    expect(JSON.stringify(view.pages)).not.toContain("selestial.io/privacy");
    expect(view.pages.every((row) => row.state === "published" && row.check?.ok)).toBe(true);
    expect(view.places.map((row) => [row.place, row.state])).toEqual([
      ["booking_form", "records"],
      ["team_onboarding", "records"],
    ]);

    // An edit is the owner's: changing their details later never rewrites it.
    await as.mutation(api.textingSetup.save, { companyId, revision: await revision(as, companyId), drafts: { help_reply: "Alpha Cleaning: call (512) 555-0100 for help. Reply STOP to opt out." } });
    await as.mutation(api.textingSetup.save, { companyId, revision: await revision(as, companyId), business: { supportPhone: "(512) 555-0199" } });
    const edited = (await as.query(api.textingSetup.view, { companyId }))!;
    expect(edited.setup.drafts.help_reply).toMatchObject({ edited: true, text: "Alpha Cleaning: call (512) 555-0100 for help. Reply STOP to opt out." });
    expect(edited.setup.drafts.terms.text).toContain("(512) 555-0199".replace(/\D/g, "").slice(-4));

    // Anyone can read the published pages; a sign-up records exactly what that version said.
    const page = await t.query(api.textingPublic.page, { handle: "alpha-cleaning", kind: "signup" });
    expect(page).toMatchObject({ company: { name: "Alpha Cleaning" }, kind: "signup", version: 1 });
    expect(await t.query(api.textingPublic.page, { handle: "nobody-here", kind: "privacy" })).toBeNull();
    process.env.PUBLIC_FORM_SECRET = "form-secret";
    try {
      const sign = (fields: Partial<{ version: number; texts: boolean; marketing: boolean; phone: string }> = {}) => t.mutation(api.textingPublic.signup, { secret: "form-secret", handle: "alpha-cleaning", version: 1, name: "Casey Park", phone: "(512) 555-0177", texts: true, marketing: false, visitorKey: "v1", ...fields });
      expect(await sign({ version: 2 })).toMatchObject({ refused: expect.stringContaining("just updated") });
      expect(await sign({ texts: false })).toMatchObject({ refused: expect.stringContaining("Nothing was recorded") });
      expect(await sign()).toMatchObject({ ok: true });
      const permissions = await t.run(async (ctx) => ctx.db.query("contactPermissions").collect());
      const disclosure = await t.run(async (ctx) => ctx.db.get(permissions[0].disclosureId!));
      expect(permissions).toHaveLength(1);
      expect(permissions[0]).toMatchObject({ channel: "sms", category: "operational", status: "granted", source: "web_form", recordedBy: { kind: "recipient" } });
      expect(permissions[0].evidence).toContain("version 1");
      expect(disclosure?.text).toBe(page!.body);
      // Marketing is its own permission, only when the person checks its own box.
      await sign({ marketing: true });
      const marketing = await t.run(async (ctx) => (await ctx.db.query("contactPermissions").collect()).filter((row) => row.category === "marketing"));
      expect(marketing).toHaveLength(1);
    } finally {
      delete process.env.PUBLIC_FORM_SECRET;
    }
  });

  it("recommends one registration for what was chosen, by content and audience", () => {
    expect(planFor(["job_offers", "arrival_reminders"], "PRIVATE_PROFIT")).toMatchObject({ usecase: "ACCOUNT_NOTIFICATION", subUsecases: [], coverage: [{ audience: "cleaner", category: "operational" }] });
    expect(planFor(["inquiry_replies", "job_offers", "promotions"], "PRIVATE_PROFIT")).toMatchObject({ usecase: "MIXED", subUsecases: ["CUSTOMER_CARE", "ACCOUNT_NOTIFICATION", "MARKETING"], marketing: true });
    expect(planFor(["inquiry_replies"], "SOLE_PROPRIETOR")).toMatchObject({ usecase: "SOLE_PROPRIETOR" });
    expect(planFor([], "PRIVATE_PROFIT")).toBeNull();
    const input = { name: "Bravo Maids", activities: ["inquiry_replies"], marketingPerWeek: 2, links: { privacy: "https://x.test/p", terms: "https://x.test/t" }, places: [] };
    expect(draftGaps("sms_consent", draftFor("sms_consent", input), input)).toEqual([]);
    expect(draftGaps("sms_consent", "Texts from us. Reply STOP. Get our best deals!", input)).toEqual(expect.arrayContaining(["name your business (Bravo Maids)", "say how to get help (HELP)", "leave promotions out (they need their own, separate permission)"]));
  });

  it("files nothing until Selestial review approves, then registers, buys and connects in order, each once", async () => {
    const telnyx = fakeTelnyx();
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const admin = t.withIdentity(ADMIN);

    // Submitting needs everything, and the charges accepted in the exact words shown.
    await as.mutation(api.textingSetup.open, { companyId });
    const early = (await as.query(api.textingSetup.view, { companyId }))!;
    expect(await refusal(as.mutation(api.textingSetup.submit, { companyId, revision: early.setup.revision, authorization: early.charges.wording }))).toBeTruthy();
    await prepare(t, as, companyId);
    const view = (await as.query(api.textingSetup.view, { companyId }))!;
    expect(await refusal(as.mutation(api.textingSetup.submit, { companyId, revision: view.setup.revision, authorization: "I agree" }))).toContain("accept the charges");
    const { requestId } = await submit(as, companyId);
    expect(await refusal(submit(as, companyId))).toContain("already with Selestial");
    // Searching is all Telnyx has seen: nothing is filed or bought by submitting.
    expect(telnyx.posts()).toEqual([]);
    const progress = (await as.query(api.textingSetup.view, { companyId }))!.request!;
    expect(progress.milestones.map((row) => [row.key, row.state])).toEqual([
      ["submitted", "working"],
      ["business", "waiting"],
      ["messaging", "waiting"],
      ["purchase", "waiting"],
      ["connection", "waiting"],
      ["ready", "waiting"],
    ]);

    expect(await refusal(as.mutation(api.texting.approve, { requestId }))).toBe("Not found.");
    await admin.mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const done = (await as.query(api.textingSetup.view, { companyId }))!.request!;
    expect(done.status).toBe("active");
    expect(done.milestones.every((row) => row.state === "done")).toBe(true);
    // In order: the business, then the campaign, then (only after approval) the company's own messaging profile and its
    // keyword answers, then the number onto that profile, then the connection.
    expect(telnyx.posts()).toEqual(["POST /10dlc/brand", "POST /10dlc/campaignBuilder", "POST /messaging_profiles", "POST /messaging_profiles/profile-1/autoresp_configs", "POST /messaging_profiles/profile-1/autoresp_configs", "POST /messaging_profiles/profile-1/autoresp_configs", "POST /number_orders", "POST /10dlc/phone_number_campaigns"]);
    // The profile is this company's alone, sends incoming texts to this backend, and the number is bought onto it.
    expect(telnyx.profiles).toEqual([{ id: "profile-1", name: `Selestial · Alpha Cleaning · ${requestId}`, webhook: "https://deployment.convex.site.test/webhooks/telnyx" }]);
    expect(telnyx.autoReplies.map((row) => row.op).sort()).toEqual(["info", "start", "stop"]);
    expect(telnyx.autoReplies.find((row) => row.op === "stop")!.text).toContain("Alpha Cleaning");
    expect(telnyx.calls.find((call) => call.path === "/number_orders" && call.method === "POST")!.body).toMatchObject({ messaging_profile_id: "profile-1" });
    const brand = telnyx.calls.find((call) => call.path === "/10dlc/brand" && call.method === "POST")!.body!;
    expect(brand).toMatchObject({ entityType: "PRIVATE_PROFIT", displayName: "Alpha Cleaning", companyName: "Alpha Cleaning LLC", ein: "12-3456789", state: "TX", website: "https://alpha.example", email: "help@alpha.example", webhookURL: "https://deployment.convex.site.test/webhooks/telnyx" });
    const campaign = telnyx.calls.find((call) => call.path === "/10dlc/campaignBuilder")!.body!;
    expect(campaign).toMatchObject({ brandId: "brand-1", usecase: "MIXED", subUsecases: ["CUSTOMER_CARE", "ACCOUNT_NOTIFICATION", "MARKETING"], referenceId: `sel-${requestId}-v1` });
    expect(String(campaign.privacyPolicyLink)).toMatch(/\/b\/alpha-cleaning\/legal\/privacy$/);
    expect(String(campaign.termsAndConditionsLink)).toMatch(/\/b\/alpha-cleaning\/legal\/texting$/);
    expect(JSON.stringify(campaign)).not.toContain("selestial.io/privacy");
    expect(String(campaign.description)).toContain("Promotional texts go only to people who separately agreed");
    // The number was checked again right before it was bought.
    const availability = telnyx.calls.findIndex((call) => call.path.includes("ends_with"));
    expect(availability).toBeGreaterThan(-1);
    expect(availability).toBeLessThan(telnyx.calls.findIndex((call) => call.path === "/number_orders" && call.method === "POST"));

    // Texting is ready, and covers exactly what was registered.
    const profile = await as.query(api.compliance.profile, { companyId });
    expect(profile.messaging).toMatchObject({ smsNumber: NUMBER, senderName: "Alpha Cleaning", messagingProfileId: "profile-1", registration: { status: "approved", reference: "campaign-1" } });
    expect(profile.messaging.registration.coverage).toEqual(expect.arrayContaining([{ audience: "customer", category: "operational" }, { audience: "cleaner", category: "operational" }, { audience: "customer", category: "marketing" }]));
    expect(profile.messaging.registration.coverage).not.toContainEqual({ audience: "applicant", category: "recruiting" });
  });

  it("asks the owner to choose again when the chosen number was taken, and never swaps it silently", async () => {
    let available = false;
    const telnyx = fakeTelnyx({ available: () => available });
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const admin = t.withIdentity(ADMIN);
    const searchId = await prepare(t, as, companyId);
    const { requestId } = await submit(as, companyId);
    await admin.mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const view = (await as.query(api.textingSetup.view, { companyId }))!;
    expect(view.request).toMatchObject({ status: "needs_you", needs: { kind: "number" } });
    expect(view.request!.milestones.find((row) => row.key === "purchase")).toMatchObject({ state: "needs_you", ownerAction: true });
    expect(telnyx.posts()).not.toContain("POST /number_orders");

    // The owner chooses another; it goes back through Selestial review; the brand and campaign are not filed again.
    available = true;
    await as.mutation(api.textingSetup.chooseNumber, { companyId, revision: await revision(as, companyId), searchId, phoneNumber: OTHER });
    await submit(as, companyId);
    await admin.mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await t.run(async (ctx) => ctx.db.get(requestId));
    expect(after).toMatchObject({ status: "active", phoneNumber: OTHER });
    expect(telnyx.posts().filter((post) => post === "POST /10dlc/brand" || post === "POST /10dlc/campaignBuilder")).toHaveLength(2);
    expect(telnyx.posts().filter((post) => post === "POST /number_orders")).toHaveLength(1);
  });

  it("finds a number order whose answer was lost instead of buying a second one", async () => {
    const telnyx = fakeTelnyx({ loseFirstOrderAnswer: true });
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await prepare(t, as, companyId);
    const { requestId } = await submit(as, companyId);
    await t.withIdentity(ADMIN).mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run(async (ctx) => ctx.db.get(requestId)))?.status).toBe("active");
    expect(telnyx.posts().filter((post) => post === "POST /number_orders")).toHaveLength(1);
    expect(telnyx.calls.some((call) => call.method === "GET" && call.path.startsWith("/number_orders?filter[customer_reference]="))).toBe(true);
  });

  it("finds a messaging profile whose creation answer was lost instead of making a second one", async () => {
    const telnyx = fakeTelnyx({ loseFirstProfileAnswer: true });
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await prepare(t, as, companyId);
    const { requestId } = await submit(as, companyId);
    await t.withIdentity(ADMIN).mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run(async (ctx) => ctx.db.get(requestId)))?.status).toBe("active");
    expect(telnyx.profiles).toHaveLength(1);
    expect(telnyx.calls.some((call) => call.method === "GET" && call.path.startsWith("/messaging_profiles?filter[name]="))).toBe(true);
    expect(telnyx.calls.find((call) => call.path === "/number_orders" && call.method === "POST")!.body).toMatchObject({ messaging_profile_id: "profile-1" });
  });

  it("runs one provisioning pass at a time", async () => {
    const telnyx = fakeTelnyx();
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await prepare(t, as, companyId);
    const { requestId } = await submit(as, companyId);
    await t.withIdentity(ADMIN).mutation(api.texting.approve, { requestId });
    // A second run (a callback, the reconciler) while the first holds the request does nothing.
    await t.mutation(internal.texting.claim, { requestId, token: "other-pass" });
    await t.action(internal.texting.provision, { requestId });
    expect(telnyx.posts()).toEqual([]);
    await t.mutation(internal.texting.release, { requestId, token: "other-pass" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(telnyx.posts().filter((post) => post === "POST /10dlc/brand")).toHaveLength(1);
  });

  it("keeps texts waiting while the number connection is pending after approval", async () => {
    const telnyx = fakeTelnyx({ assignment: () => "PENDING_ASSIGNMENT" });
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await prepare(t, as, companyId);
    const { requestId } = await submit(as, companyId);
    await t.withIdentity(ADMIN).mutation(api.texting.approve, { requestId });
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(31 * 60_000);
      await t.finishInProgressScheduledFunctions();
    }
    const view = (await as.query(api.textingSetup.view, { companyId }))!;
    expect(view.request!.status).toBe("waiting_on_carriers");
    expect(view.request!.milestones.map((row) => [row.key, row.state])).toEqual([
      ["submitted", "done"],
      ["business", "done"],
      ["messaging", "done"],
      ["purchase", "done"],
      ["connection", "working"],
      ["ready", "waiting"],
    ]);
    // Nothing can be texted yet: the profile has no number.
    expect((await as.query(api.compliance.profile, { companyId })).messaging.smsNumber).toBeUndefined();
  });

  it("asks for a correction in plain words, keeps everything else, and refiles only what changed, charging once", async () => {
    process.env.MESSAGING_BILLING = "on";
    vi.setSystemTime(Date.UTC(2026, 10, 19, 15));
    let fixed = false;
    const telnyx = fakeTelnyx({ brand: (n) => (fixed ? (n === 1 ? { identityStatus: null, status: "REGISTRATION_PENDING" } : { identityStatus: "VERIFIED", status: "OK" }) : n === 1 ? { identityStatus: null } : { identityStatus: "UNVERIFIED", status: "OK", failureReasons: [{ fields: ["ein", "companyName"], description: "EIN does not match the legal name." }] }) });
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await t.action(internal.billing.syncCompany, { companyId });
    // A $1.00 balance: less than the fees. Texting still becomes ready; a low balance never releases the number.
    billing.seed(companyId, { messaging: { purchased: 10_000, promo: 0, promoExpiresAt: null, used: 0 } });
    await t.action(internal.billing.syncCompany, { companyId });
    const admin = t.withIdentity(ADMIN);
    await prepare(t, as, companyId);
    const { requestId } = await submit(as, companyId);
    await admin.mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const view = (await as.query(api.textingSetup.view, { companyId }))!;
    expect(view.request).toMatchObject({ status: "needs_you", needs: { kind: "correction", fields: ["taxId", "legalName"] } });
    expect(view.request!.needs!.words).toContain("legal name and EIN match your IRS letter");
    expect(view.editable).toBe(true);
    expect(view.setup.business.street).toBe("1 Main St");
    // The raw provider reason is for staff, not the owner's screen.
    expect(JSON.stringify(view)).not.toContain("UNVERIFIED");

    fixed = true;
    await as.mutation(api.textingSetup.save, { companyId, revision: await revision(as, companyId), business: { legalName: "Alpha Cleaning Services LLC" } });
    // The legal name is in the privacy policy and terms: they must be published again before the correction goes.
    expect(await refusal(submit(as, companyId))).toContain("changed since they were published");
    await as.mutation(api.textingSetup.publish, { companyId, revision: await revision(as, companyId) });
    await settle(t);
    expect((await t.run(async (ctx) => ctx.db.query("textingPages").collect())).filter((row) => row.kind === "privacy").map((row) => [row.version, row.retiredAt === undefined])).toEqual([
      [1, false],
      [2, true],
    ]);
    await submit(as, companyId);
    expect((await t.run(async (ctx) => ctx.db.get(requestId)))).toMatchObject({ status: "requested", submissionVersion: 2 });
    await admin.mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run(async (ctx) => ctx.db.get(requestId)))?.status).toBe("active");
    expect(telnyx.posts()).toEqual(["POST /10dlc/brand", "PUT /10dlc/brand/brand-1", "PUT /10dlc/brand/brand-1/revet", "POST /10dlc/campaignBuilder", "POST /messaging_profiles", "POST /messaging_profiles/profile-1/autoresp_configs", "POST /messaging_profiles/profile-1/autoresp_configs", "POST /messaging_profiles/profile-1/autoresp_configs", "POST /number_orders", "POST /10dlc/phone_number_campaigns"]);
    const submissions = await t.run(async (ctx) => ctx.db.query("textingSubmissions").collect());
    expect(submissions.map((row) => [row.version, row.business.legalName])).toEqual([
      [1, "Alpha Cleaning LLC"],
      [2, "Alpha Cleaning Services LLC"],
    ]);
    // Registration fees: setup once, the correction once, then the monthly fees from the day texting is ready.
    const fees = (await t.run(async (ctx) => ctx.db.query("messagingCharges").collect())).filter((row) => row.kind === "registration_fee" || row.kind === "number_monthly");
    expect(fees.map((row) => [row.activity, row.amount])).toEqual([
      ["Texting registration setup", 190_000],
      ["Corrected texting registration", 150_000],
      ["Texting number +15125550142, 2026-11", 30_000],
      ["Texting registration, 2026-11", 100_000],
    ]);
    await t.mutation(internal.texting.chargeNumbers, {});
    expect((await t.run(async (ctx) => ctx.db.query("messagingCharges").collect())).filter((row) => row.kind === "registration_fee" || row.kind === "number_monthly")).toHaveLength(4);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(billing.messagingLeft(billing.customerFor(`company_${companyId}`))).toBe(10_000 - 190_000 - 150_000 - 30_000 - 100_000);
    expect((await t.run(async (ctx) => ctx.db.get(requestId)))?.status).toBe("active");
  });

  it("confirms a sole proprietor with the carriers' one-time code", async () => {
    const telnyx = fakeTelnyx({ brand: (n) => (n < 3 ? { identityStatus: "SELF_DECLARED", status: "OK" } : { identityStatus: "VERIFIED", status: "OK" }) });
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Casey's Cleaning");
    await prepare(t, as, companyId, { business: { entityType: "SOLE_PROPRIETOR", displayName: "Casey's Cleaning", contactFirstName: "Casey", contactLastName: "Park", mobilePhone: "(512) 555-0188" }, activities: ["inquiry_replies", "job_offers"], taxId: null });
    const { requestId } = await submit(as, companyId);
    await t.withIdentity(ADMIN).mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const brand = telnyx.calls.find((call) => call.path === "/10dlc/brand" && call.method === "POST")!.body!;
    expect(brand).toMatchObject({ entityType: "SOLE_PROPRIETOR", firstName: "Casey", lastName: "Park", mobilePhone: "+15125550188" });
    expect(brand.ein).toBeUndefined();
    expect(brand.companyName).toBeUndefined();
    const waiting = (await as.query(api.textingSetup.view, { companyId }))!.request!;
    expect(waiting).toMatchObject({ status: "needs_you", needs: { kind: "code" } });
    expect(waiting.needs!.words).toContain("ending in 0188");
    expect(String(telnyx.calls.find((call) => call.path.endsWith("/smsOtp") && call.method === "POST")!.body!.pinSms)).toContain("@OTP_PIN@");
    // While a code is awaited, the setup can't be changed.
    expect((await as.query(api.textingSetup.view, { companyId }))!.editable).toBe(false);

    await as.mutation(api.texting.confirmCode, { companyId, requestId, code: "000000" });
    await settle(t);
    expect((await as.query(api.textingSetup.view, { companyId }))!.request!.needs!.words).toContain("didn't work");
    await as.mutation(api.texting.confirmCode, { companyId, requestId, code: "123456" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run(async (ctx) => ctx.db.get(requestId)))?.status).toBe("active");
    const campaign = telnyx.calls.find((call) => call.path === "/10dlc/campaignBuilder")!.body!;
    expect(campaign.usecase).toBe("SOLE_PROPRIETOR");
  });

  it("acts on a signed 10DLC callback once, and only as a hint", async () => {
    const telnyx = fakeTelnyx();
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await prepare(t, as, companyId);
    const { requestId } = await submit(as, companyId);
    await t.withIdentity(ADMIN).mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (let i = 0; i < 2; i += 1) await t.mutation(internal.texting.registrationEvent, { eventId: "evt-1", type: "10dlc.campaign.update", campaignId: "campaign-1" });
    expect(await t.run(async (ctx) => ctx.db.query("telnyxEvents").collect())).toEqual([expect.objectContaining({ eventId: "evt-1", requestId })]);
  });

  it("stops texts that the registration doesn't cover, and when the carriers suspend it", async () => {
    const telnyx = fakeTelnyx();
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await prepare(t, as, companyId, { activities: ["job_offers", "arrival_reminders"] });
    const { requestId } = await submit(as, companyId);
    await t.withIdentity(ADMIN).mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const customerId = await t.run(async (ctx) => ctx.db.insert("customers", { companyId, name: "Pat", kind: "home", phone: "+15125550170", status: "active", createdAt: Date.now() }));
    const check = (category: "operational" | "marketing") => as.query(api.consent.check, { companyId, channel: "sms", to: "+15125550170", recipient: { kind: "customer", id: customerId }, category, origin: "manual" });
    // Registered for cleaner work texts only: a text to a customer is refused before consent is even checked.
    expect(await check("operational")).toMatchObject({ ok: false, code: "not_registered" });
    expect((await check("marketing")) as { words: string }).toMatchObject({ ok: false, code: "not_registered" });

    // The carriers suspend it: texts stop, and the owner sees why.
    const stoppedTelnyx = fakeTelnyx({ campaign: () => "TCR_SUSPENDED" });
    vi.stubGlobal("fetch", stoppedTelnyx.fetcher);
    await t.action(internal.texting.checkActive, { requestId });
    expect((await t.run(async (ctx) => ctx.db.get(requestId)))?.status).toBe("interrupted");
    expect((await as.query(api.compliance.profile, { companyId })).messaging.registration.status).toBe("suspended");
    const milestones = (await as.query(api.textingSetup.view, { companyId }))!.request!.milestones;
    expect(milestones.find((row) => row.key === "ready")).toMatchObject({ state: "problem" });
  });

  it("tells each agent exactly what it can text, answers HELP in the company's own words, and tells the owner at each moment", async () => {
    const telnyx = fakeTelnyx();
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await prepare(t, as, companyId, { activities: ["inquiry_replies", "job_offers", "arrival_reminders"] });
    expect((await as.query(api.texting.agentTexting, { companyId })).map((row) => [row.agent, row.state])).toEqual([
      ["sales", "setup_needed"],
      ["dispatch", "setup_needed"],
      ["recruiter", "setup_needed"],
      ["retention", "setup_needed"],
    ]);
    const { requestId } = await submit(as, companyId);
    expect((await as.query(api.texting.agentTexting, { companyId }))[0].state).toBe("in_progress");
    await t.withIdentity(ADMIN).mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const agents = await as.query(api.texting.agentTexting, { companyId });
    const of = (agent: string) => agents.find((row) => row.agent === agent)!;
    expect(of("dispatch")).toMatchObject({ state: "ready", words: expect.stringContaining("to cleaners who agreed to texts") });
    // Customer work texts are registered; promotions are not.
    expect(of("retention")).toMatchObject({ state: "partly", words: expect.stringContaining("Promotional texting is not included in your current registration.") });
    expect(of("retention").activities.find((row) => row.key === "promotions")).toMatchObject({ ready: false });
    expect(of("recruiter").state).toBe("setup_needed");

    // HELP is answered with the reply registered with the carriers.
    const registered = (await t.run(async (ctx) => ctx.db.get(requestId)))!.drafts!.help_reply;
    await t.mutation(internal.inbound.sms, { to: NUMBER, from: "+15125550177", body: "HELP", receivedAt: Date.now() });
    const replies = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((row) => row.to === "+15125550177"));
    expect(replies.map((row) => row.body)).toContain(registered);

    // The owner heard at the moments that matter, and not at each internal step.
    const notices = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((row) => row.purpose === "member_notice").map((row) => row.notice?.event));
    expect(notices.filter((event) => event === "texting_progress")).toHaveLength(3);
    expect(notices.filter((event) => event === "texting_attention")).toHaveLength(0);
  });

  it("keeps a STOP in force across agents and after the texting number changes", async () => {
    vi.stubGlobal("fetch", fakeTelnyx().fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await prepare(t, as, companyId);
    const { requestId } = await submit(as, companyId);
    await t.withIdentity(ADMIN).mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const customerId = await t.run(async (ctx) => ctx.db.insert("customers", { companyId, name: "Pat", kind: "home", phone: "+15125550170", status: "active", createdAt: Date.now() }));
    await as.mutation(api.consent.record, { companyId, recipient: { kind: "customer", id: customerId }, channel: "sms", category: "operational", status: "granted", source: "paper_form", evidence: "Signed form." });
    const check = (agent: "sales" | "retention") => as.query(api.consent.check, { companyId, channel: "sms", to: "+15125550170", recipient: { kind: "customer", id: customerId }, category: "operational", origin: "agent", agent });
    expect(await check("sales")).toMatchObject({ ok: true });
    await t.mutation(internal.inbound.sms, { to: NUMBER, from: "+15125550170", body: "STOP", receivedAt: Date.now() });
    expect(await check("sales")).toMatchObject({ ok: false, code: "suppressed" });
    expect(await check("retention")).toMatchObject({ ok: false, code: "suppressed" });
    // A new number doesn't start over: the STOP belongs to the person's number, for this business.
    await t.run(async (ctx) => {
      const profile = (await ctx.db.query("complianceProfiles").collect())[0];
      await ctx.db.patch(profile._id, { messaging: { ...profile.messaging, smsNumber: "+15125550199" } });
    });
    expect(await check("sales")).toMatchObject({ ok: false, code: "suppressed" });
  });

  it("keeps each company's setup, searches and requests to itself", async () => {
    vi.stubGlobal("fetch", fakeTelnyx().fetcher);
    const t = start();
    const a = await company(t, "owner-a", "Alpha Cleaning");
    const b = await company(t, "owner-b", "Bravo Maids");
    const searchId = await prepare(t, a.as, a.companyId);
    const { requestId } = await submit(a.as, a.companyId);
    await b.as.mutation(api.textingSetup.open, { companyId: b.companyId });
    expect(await refusal(b.as.mutation(api.textingSetup.chooseNumber, { companyId: b.companyId, revision: await revision(b.as, b.companyId), searchId, phoneNumber: NUMBER }))).toBe("Choose a number from your search.");
    expect(await refusal(b.as.query(api.texting.search, { companyId: b.companyId, searchId }))).toBe("Not found.");
    expect(await refusal(b.as.mutation(api.texting.confirmCode, { companyId: b.companyId, requestId, code: "123456" }))).toBe("Not found.");
    expect((await b.as.query(api.textingSetup.view, { companyId: b.companyId }))!.request).toBeNull();
    expect(await b.as.query(api.texting.status, { companyId: b.companyId })).toBeNull();
    expect(await refusal(b.as.query(api.textingSetup.view, { companyId: a.companyId }))).toBe("Not found.");
  });
});

describe("Texting launch fixes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.TELNYX_API_KEY = "KEY_test";
    process.env.MAILBOX_TOKEN_KEY = KEY;
    process.env.STAFF_BOOTSTRAP_EMAIL = ADMIN.email;
    process.env.TELNYX_WEBHOOK_URL = "https://deployment.convex.site.test";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const name of ["TELNYX_API_KEY", "MAILBOX_TOKEN_KEY", "STAFF_BOOTSTRAP_EMAIL", "TELNYX_WEBHOOK_URL", "MESSAGING_BILLING", "CONVEX_CLOUD_URL"]) delete process.env[name];
  });

  const attention = (t: ReturnType<typeof start>) => t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((row) => row.notice?.event === "texting_attention").map((row) => row.notice?.facts?.kind));

  it("turns down a fresh request and tells the owner, but never a corrected one that is already filed", async () => {
    let fixed = false;
    const telnyx = fakeTelnyx({ brand: (n) => (fixed ? (n === 1 ? { identityStatus: null } : { identityStatus: "VERIFIED", status: "OK" }) : n === 1 ? { identityStatus: null } : { identityStatus: "UNVERIFIED", status: "OK", failureReasons: [{ fields: ["ein"], description: "EIN mismatch." }] }) });
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const admin = t.withIdentity(ADMIN);
    // A fresh request: nothing is filed, so it can be turned down, and the owner is told.
    const b = await company(t, "owner-b", "Bravo Maids");
    await prepare(t, b.as, b.companyId, { business: { displayName: "Bravo Maids", legalName: "Bravo Maids LLC" } });
    const fresh = await submit(b.as, b.companyId);
    await admin.mutation(api.texting.reject, { requestId: fresh.requestId, note: "The website doesn't show this business." });
    expect((await t.run((ctx) => ctx.db.get(fresh.requestId)))?.status).toBe("rejected");
    expect(await attention(t)).toEqual(["rejected"]);
    expect(telnyx.posts()).toEqual([]);

    // A corrected request: the brand is filed and the setup fee charged. Turning it down would file and charge again.
    const a = await company(t, "owner-a", "Alpha Cleaning");
    await prepare(t, a.as, a.companyId);
    const { requestId } = await submit(a.as, a.companyId);
    await admin.mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run((ctx) => ctx.db.get(requestId)))).toMatchObject({ status: "needs_you", brandId: "brand-1" });
    fixed = true;
    await a.as.mutation(api.textingSetup.save, { companyId: a.companyId, revision: await revision(a.as, a.companyId), samples: { job_offers: "Alpha Cleaning: a job is open Saturday at 9. Reply YES to take it. Reply STOP to opt out." } });
    await submit(a.as, a.companyId);
    expect((await t.run((ctx) => ctx.db.get(requestId)))).toMatchObject({ status: "requested", submissionVersion: 2, brandId: "brand-1" });
    expect(await refusal(admin.mutation(api.texting.reject, { requestId, note: "No." }))).toContain("Use Send back");
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("requested");
    expect(await t.run(async (ctx) => (await ctx.db.query("textingRequests").collect()).filter((row) => row.companyId === a.companyId).length)).toBe(1);
    expect(telnyx.posts().filter((post) => post === "POST /10dlc/brand")).toHaveLength(1);
  });

  it("lets only the number change once the carriers approved, and never activates a registration that changed after approval", async () => {
    let available = false;
    const telnyx = fakeTelnyx({ available: () => available });
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const admin = t.withIdentity(ADMIN);
    const searchId = await prepare(t, as, companyId, { activities: ["job_offers", "arrival_reminders"] });
    const { requestId } = await submit(as, companyId);
    await admin.mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const view = (await as.query(api.textingSetup.view, { companyId }))!;
    expect(view).toMatchObject({ editable: false, numberOnly: true, request: { status: "needs_you", needs: { kind: "number" } } });
    // Adding marketing now would never be filed: it is refused, and so is every other answer.
    expect(await refusal(as.mutation(api.textingSetup.save, { companyId, revision: await revision(as, companyId), activities: ["job_offers", "arrival_reminders", "promotions"] }))).toContain("only the number can change");
    expect(await refusal(as.mutation(api.textingSetup.save, { companyId, revision: await revision(as, companyId), samples: { job_offers: "Different." } }))).toContain("only the number can change");
    expect(await refusal(as.mutation(api.textingSetup.clearTaxId, { companyId, revision: await revision(as, companyId) }))).toContain("can't be changed");
    // Moving between steps is still saved.
    await as.mutation(api.textingSetup.save, { companyId, revision: await revision(as, companyId), step: "number" });

    // Belt and braces: a request whose coverage changed after approval (however it happened) goes to staff, not to "active".
    await t.run((ctx) => ctx.db.patch(requestId, { status: "approved", needs: undefined, submissionVersion: 2, activities: ["job_offers", "arrival_reminders", "promotions"], subUsecases: ["ACCOUNT_NOTIFICATION", "MARKETING"] }));
    available = true;
    await t.action(internal.texting.provision, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const stopped = (await t.run((ctx) => ctx.db.get(requestId)))!;
    expect(stopped.status).toBe("failed");
    expect(stopped.problem).toContain("changed after the carriers approved");
    expect(telnyx.posts()).not.toContain("POST /number_orders");
    expect((await as.query(api.compliance.profile, { companyId })).messaging.registration.status).not.toBe("approved");
    expect(await attention(t)).toEqual(["needs_you", "failed"]);
    void searchId;
  });

  it("does not charge a correction fee for a campaign the carriers can't review again", async () => {
    process.env.MESSAGING_BILLING = "on";
    const telnyx = fakeTelnyx({ campaign: () => "TCR_FAILED" });
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await t.action(internal.billing.syncCompany, { companyId });
    const admin = t.withIdentity(ADMIN);
    await prepare(t, as, companyId);
    const { requestId } = await submit(as, companyId);
    await admin.mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run((ctx) => ctx.db.get(requestId)))).toMatchObject({ status: "needs_you", needs: { kind: "correction" }, campaignId: "campaign-1" });
    const fees = async () => (await t.run(async (ctx) => ctx.db.query("messagingCharges").collect())).filter((row) => row.kind === "registration_fee").map((row) => row.activity);
    expect(await fees()).toEqual(["Texting registration setup"]);

    // The owner sends the same registration again, twice: nothing is filed and nothing is charged either time.
    for (const version of [2, 3]) {
      if (version === 3) await t.run((ctx) => ctx.db.patch(requestId, { status: "needs_you", needs: { kind: "correction", words: "Again.", fields: [], at: Date.now() } }));
      await as.mutation(api.textingSetup.save, { companyId, revision: await revision(as, companyId), samples: { job_offers: `Alpha Cleaning: job open Saturday at ${version}. Reply YES to take it. Reply STOP to opt out.` } });
      await submit(as, companyId);
      await admin.mutation(api.texting.approve, { requestId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const row = (await t.run((ctx) => ctx.db.get(requestId)))!;
      expect(row.status).toBe("failed");
      expect(row.problem).toContain("TCR_FAILED");
    }
    expect(telnyx.posts().filter((post) => post.startsWith("PUT /10dlc/campaign"))).toEqual([]);
    expect(await fees()).toEqual(["Texting registration setup"]);
  });

  it("lets staff retry a failed number connection without buying another number", async () => {
    const telnyx = fakeTelnyx({ assignment: (n) => (n === 1 ? "FAILED_ASSIGNMENT" : "ASSIGNED") });
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const admin = t.withIdentity(ADMIN);
    await prepare(t, as, companyId);
    const { requestId } = await submit(as, companyId);
    await admin.mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const failed = (await t.run((ctx) => ctx.db.get(requestId)))!;
    expect(failed.status).toBe("failed");
    expect(failed.assignedAt).toBeUndefined();
    expect(failed.numberOrderedAt).toBeTypeOf("number");
    // The owner is told, honestly, that it is on Selestial's side.
    expect(await attention(t)).toEqual(["failed"]);
    await admin.mutation(api.texting.retry, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("active");
    expect(telnyx.posts().filter((post) => post === "POST /10dlc/phone_number_campaigns")).toHaveLength(2);
    expect(telnyx.posts().filter((post) => post === "POST /number_orders")).toHaveLength(1);
  });

  it("records an unauthorized monthly fee once a month, not at every sweep", async () => {
    process.env.MESSAGING_BILLING = "on";
    vi.setSystemTime(Date.UTC(2026, 10, 19, 15));
    vi.stubGlobal("fetch", fakeTelnyx().fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await t.action(internal.billing.syncCompany, { companyId });
    await prepare(t, as, companyId);
    const { requestId } = await submit(as, companyId);
    await t.withIdentity(ADMIN).mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // An older request: active, with no fee authorization on it.
    await t.run((ctx) => ctx.db.patch(requestId, { fees: undefined, feeMonth: undefined, registrationMonth: undefined }));
    const recorded = async () => (await t.run(async (ctx) => ctx.db.query("events").collect())).filter((row) => row.type === "texting.fee_not_authorized").map((row) => row.data?.month);
    for (let i = 0; i < 4; i += 1) await t.mutation(internal.texting.chargeNumbers, {});
    expect(await recorded()).toEqual(["2026-11"]);
    vi.setSystemTime(Date.UTC(2026, 11, 2, 15));
    for (let i = 0; i < 3; i += 1) await t.mutation(internal.texting.chargeNumbers, {});
    expect(await recorded()).toEqual(["2026-11", "2026-12"]);
  });

  it("treats REVOKE, OPTOUT and a plain 'please stop' as opt-outs, and lets START undo a stop said in the person's own words", async () => {
    for (const word of ["REVOKE", "revoke.", "OPTOUT", "Opt out", "opt-out", "STOP", " end "]) expect(classify(word)).toBe("stop");
    for (const words of ["please stop", "Please stop.", "Stop texting me", "stop texting me please!", "Stop these texts", "stop sending me messages", "pls stop", "Stop it", "please unsubscribe"]) expect(classify(words)).toBe("plain_stop");
    for (const words of ["Can you stop by at 3?", "Don't stop the weekly cleaning", "I can't stop thinking about how clean it is", "The bus stop is on Main", "Yes please"]) expect(classify(words)).not.toBe("plain_stop");
    expect(classify("Can you stop by at 3?")).toBe("ignored");

    vi.stubGlobal("fetch", fakeTelnyx().fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await prepare(t, as, companyId);
    const { requestId } = await submit(as, companyId);
    await t.withIdentity(ADMIN).mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // The keywords filed with the carriers name them too.
    const filed = (await t.run((ctx) => ctx.db.get(requestId)))!;
    expect(campaignFor(filed, { brandId: "b", reference: "r", webhookURL: null }).optoutKeywords.split(",")).toEqual(expect.arrayContaining(["STOP", "REVOKE", "OPTOUT"]));

    const customerId = await t.run(async (ctx) => ctx.db.insert("customers", { companyId, name: "Pat", kind: "home", phone: "+15125550170", status: "active", createdAt: Date.now() }));
    await as.mutation(api.consent.record, { companyId, recipient: { kind: "customer", id: customerId }, channel: "sms", category: "operational", status: "granted", source: "paper_form", evidence: "Signed form." });
    const check = () => as.query(api.consent.check, { companyId, channel: "sms", to: "+15125550170", recipient: { kind: "customer", id: customerId }, category: "operational", origin: "manual" });
    const text = (body: string) => t.mutation(internal.inbound.sms, { to: NUMBER, from: "+15125550170", body, receivedAt: Date.now() });
    expect(await check()).toMatchObject({ ok: true });
    expect(await text("Please stop.")).toMatchObject({ kind: "plain_stop" });
    expect(await check()).toMatchObject({ ok: false, code: "suppressed" });
    // Their own START undoes their own stop, and gives back only what it withdrew.
    expect(await text("START")).toMatchObject({ kind: "start" });
    expect(await check()).toMatchObject({ ok: true });
    expect(await text("REVOKE")).toMatchObject({ kind: "stop" });
    expect(await check()).toMatchObject({ ok: false, code: "suppressed" });
  });

  it("never points a non-production backend's links at the live site", () => {
    const set = (values: Record<string, string | undefined>) => {
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };
    const before = { LINK_ORIGIN: process.env.LINK_ORIGIN, SITE_ORIGIN: process.env.SITE_ORIGIN, CONVEX_CLOUD_URL: process.env.CONVEX_CLOUD_URL };
    try {
      // The test harness (no deployment) and production keep the fallback they always had.
      set({ LINK_ORIGIN: undefined, SITE_ORIGIN: undefined, CONVEX_CLOUD_URL: undefined });
      expect(siteOrigin()).toBe("https://selestial.io");
      set({ CONVEX_CLOUD_URL: `https://${PRODUCTION_DEPLOYMENTS[0]}.convex.cloud` });
      expect(linkOrigin()).toBe("https://selestial.io");
      // A test or restored backend with nothing set has no link address at all.
      set({ CONVEX_CLOUD_URL: "https://quiet-otter-123.convex.cloud" });
      expect(linkOrigin()).toBeNull();
      expect(siteOrigin()).toBe(NO_LINK_ORIGIN);
      expect(siteOrigin()).not.toContain("selestial.io");
      set({ SITE_ORIGIN: "https://preview.selestial.test/" });
      expect(linkOrigin()).toBe("https://preview.selestial.test");
      set({ LINK_ORIGIN: "http://localhost:3000" });
      expect(siteOrigin()).toBe("http://localhost:3000");
    } finally {
      set(before);
    }
  });
});

describe("Giving a texting number up", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 19, 15));
    process.env.TELNYX_API_KEY = "KEY_test";
    process.env.MAILBOX_TOKEN_KEY = KEY;
    process.env.STAFF_BOOTSTRAP_EMAIL = ADMIN.email;
    process.env.TELNYX_WEBHOOK_URL = "https://deployment.convex.site.test";
    process.env.MESSAGING_BILLING = "on";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const name of ["TELNYX_API_KEY", "MAILBOX_TOKEN_KEY", "STAFF_BOOTSTRAP_EMAIL", "TELNYX_WEBHOOK_URL", "MESSAGING_BILLING", "CONVEX_CLOUD_URL"]) delete process.env[name];
  });

  /** A company texting from its own number, and a staff admin who may or may not hold the destructive-actions capability. */
  async function active(options: Parameters<typeof fakeTelnyx>[0] = {}, destroy = true) {
    const telnyx = fakeTelnyx(options);
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await t.action(internal.billing.syncCompany, { companyId });
    const admin = t.withIdentity(ADMIN);
    await prepare(t, as, companyId, { activities: ["job_offers", "arrival_reminders"] });
    const { requestId } = await submit(as, companyId);
    await admin.mutation(api.texting.approve, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("active");
    if (destroy) await t.run(async (ctx) => ctx.db.patch((await ctx.db.query("staff").collect()).find((row) => row.email === ADMIN.email)!._id, { capabilities: ["records.destroy"] }));
    const item = async () => (await t.run(async (ctx) => ctx.db.query("textingExceptions").collect())).filter((row) => row.assisted?.route === "release" || row.assisted?.route === "port_out");
    const row = async () => (await t.run((ctx) => ctx.db.get(requestId)))!;
    const deletes = () => telnyx.posts().filter((post) => post.startsWith("DELETE"));
    const fees = async () => (await t.run(async (ctx) => ctx.db.query("messagingCharges").collect())).filter((charge) => charge.kind === "number_monthly" || (charge.kind === "registration_fee" && /^Texting registration, /.test(charge.activity ?? ""))).map((charge) => charge.activity);
    return { t, as, companyId, admin, requestId, telnyx, item, row, deletes, fees };
  }

  it("takes the owner's request with an explicit acceptance, once, and lets them cancel it until Selestial acts", async () => {
    const s = await active();
    const catalog = (await s.as.query(api.textingCase.workspace, { companyId: s.companyId }))!.catalog;
    expect(catalog.releaseWording).toBe(RELEASE_WORDING);
    expect(catalog.releaseWording).toMatch(/can't be recovered/);
    expect(catalog.releaseWording).toMatch(/fees continue/);
    expect(catalog.releaseWording).toMatch(/aren't refunded/);
    expect(catalog.portOutWording).toMatch(/new provider starts the transfer/);

    // Only the Owner, and only with the exact words accepted.
    const manager = await addMember(s.t, s.as, s.companyId, "manager-1", "manager");
    expect(await refusal(manager.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "release", acknowledgement: RELEASE_WORDING }))).toBe("Not allowed.");
    expect(await refusal(s.as.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "release", acknowledgement: "ok" }))).toContain("Read and accept");
    expect(await refusal(s.as.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "release", acknowledgement: PORT_OUT_WORDING }))).toContain("Read and accept");
    expect(await s.item()).toEqual([]);

    const id = await s.as.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "release", acknowledgement: RELEASE_WORDING });
    // Asking again is the same request, not a second one.
    expect(await s.as.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "release", acknowledgement: RELEASE_WORDING })).toBe(id);
    const [open] = await s.item();
    expect(await s.item()).toHaveLength(1);
    expect(open).toMatchObject({ state: "waiting_selestial", assisted: { route: "release", phoneNumber: NUMBER, source: "owner", authorization: { wording: RELEASE_WORDING } } });
    // Nothing happened to the number: it works, texts go, fees continue, Telnyx was not called.
    expect((await s.row()).status).toBe("active");
    expect((await s.as.query(api.compliance.profile, { companyId: s.companyId })).messaging).toMatchObject({ smsNumber: NUMBER, registration: { status: "approved" } });
    expect(s.deletes()).toEqual([]);
    // Staff see it in their queue although the request is active.
    expect((await s.admin.query(api.texting.queue, {})).map((row) => row.requestId)).toContain(s.requestId);

    // A transfer can't start while a release is pending, and the manager can't cancel for the owner.
    expect(await refusal(s.as.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "port_out", acknowledgement: PORT_OUT_WORDING }))).toContain("release of this number is pending");
    expect(await refusal(manager.mutation(api.textingCase.cancelOffboarding, { companyId: s.companyId, exceptionId: id }))).toBe("Not allowed.");
    await s.as.mutation(api.textingCase.cancelOffboarding, { companyId: s.companyId, exceptionId: id });
    const [cancelled] = await s.item();
    expect(cancelled).toMatchObject({ state: "resolved" });
    expect(cancelled.assisted?.authorization).toBeUndefined();
    // A cancelled request authorizes nothing, even if staff reopen the item.
    await s.t.run((ctx) => ctx.db.patch(id, { state: "waiting_selestial" }));
    expect(await refusal(s.admin.mutation(api.texting.releaseNumber, { requestId: s.requestId }))).toContain("hasn't authorized");
    expect((await s.row()).status).toBe("active");
    expect(s.deletes()).toEqual([]);
  });

  it("refuses a release without the owner's authorization for this number, without the capability, or during a transfer", async () => {
    const s = await active({}, false);
    // No request from the owner at all.
    await s.t.run(async (ctx) => ctx.db.patch((await ctx.db.query("staff").collect())[0]._id, { capabilities: [] }));
    expect(await refusal(s.admin.mutation(api.texting.releaseNumber, { requestId: s.requestId }))).toBe("Not allowed.");
    await s.t.run(async (ctx) => ctx.db.patch((await ctx.db.query("staff").collect())[0]._id, { capabilities: ["records.destroy"] }));
    expect(await refusal(s.admin.mutation(api.texting.releaseNumber, { requestId: s.requestId }))).toContain("hasn't authorized");
    expect(await refusal(s.as.mutation(api.texting.releaseNumber, { requestId: s.requestId }))).toBe("Not found.");

    // The owner says the number is moving: it can't be released while that is pending, by anyone.
    const transfer = await s.as.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "port_out", acknowledgement: PORT_OUT_WORDING });
    expect(await refusal(s.as.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "release", acknowledgement: RELEASE_WORDING }))).toContain("transfer of this number to another provider is pending");
    expect(await refusal(s.admin.mutation(api.texting.releaseNumber, { requestId: s.requestId }))).toContain("transfer of this number to another provider is pending");

    // An authorization for a different number is not one for this number.
    await s.as.mutation(api.textingCase.cancelOffboarding, { companyId: s.companyId, exceptionId: transfer });
    const release = await s.as.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "release", acknowledgement: RELEASE_WORDING });
    await s.t.run(async (ctx) => ctx.db.patch(release, { assisted: { ...(await ctx.db.get(release))!.assisted!, phoneNumber: OTHER } }));
    expect(await refusal(s.admin.mutation(api.texting.releaseNumber, { requestId: s.requestId }))).toContain("hasn't authorized");
    expect((await s.row()).status).toBe("active");
    expect(s.deletes()).toEqual([]);
  });

  it("releases the number once, stops texts and fees, and tells the owner", async () => {
    const s = await active();
    const cleanerId = await dispatchCleaner(s.as, s.companyId, "Lena");
    await s.as.mutation(api.cleaners.update, { companyId: s.companyId, cleanerId, phone: "+15125550171" });
    await s.as.mutation(api.consent.record, { companyId: s.companyId, recipient: { kind: "cleaner", id: cleanerId }, channel: "sms", category: "operational", status: "granted", source: "paper_form", evidence: "Signed form." });
    const check = () => s.as.query(api.consent.check, { companyId: s.companyId, channel: "sms", to: "+15125550171", recipient: { kind: "cleaner", id: cleanerId }, category: "operational", origin: "manual" });
    expect(await check()).toMatchObject({ ok: true });
    expect(await s.fees()).toEqual([`Texting number ${NUMBER}, 2026-11`, "Texting registration, 2026-11"]);

    const id = await s.as.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "release", acknowledgement: RELEASE_WORDING });
    expect(await s.admin.mutation(api.texting.releaseNumber, { requestId: s.requestId })).toBe("started");
    // Once Selestial has started, the owner can no longer cancel here.
    expect(await refusal(s.as.mutation(api.textingCase.cancelOffboarding, { companyId: s.companyId, exceptionId: id }))).toContain("already started");
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);

    const released = await s.row();
    expect(released).toMatchObject({ status: "released", offboarding: { route: "release" } });
    expect(released.releasedAt).toBeTypeOf("number");
    // In order: off the campaign, the number deleted, the campaign deleted. The brand is kept.
    expect(s.deletes()).toEqual([`DELETE /10dlc/phone_number_campaigns/${NUMBER}`, "DELETE /phone_numbers/num-0142", "DELETE /10dlc/campaign/campaign-1"]);
    const profile = (await s.as.query(api.compliance.profile, { companyId: s.companyId })).messaging;
    expect(profile.smsNumber).toBeUndefined();
    expect(profile.registration.status).toBe("not_started");
    expect(await check()).toMatchObject({ ok: false });
    expect((await s.item())[0]).toMatchObject({ state: "resolved" });
    expect((await s.as.query(api.textingSetup.view, { companyId: s.companyId }))!.request!.milestones.find((row) => row.key === "ready")).toMatchObject({ state: "problem", next: expect.stringContaining("released") });
    const events = (await s.t.run(async (ctx) => ctx.db.query("events").collect())).map((row) => row.type);
    expect(events).toEqual(expect.arrayContaining(["texting.release_requested", "texting.release_started", "texting.released"]));
    const notices = await s.t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((row) => row.notice?.event === "texting_progress").map((row) => row.notice?.facts?.kind));
    expect(notices).toEqual(expect.arrayContaining(["release_requested", "released"]));

    // Pressing it again, or a late run, does nothing more.
    expect(await s.admin.mutation(api.texting.releaseNumber, { requestId: s.requestId })).toBe("released");
    await s.t.action(internal.texting.offboard, { requestId: s.requestId });
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(s.deletes()).toHaveLength(3);
    // A text to the old number finds no company.
    expect(await s.t.mutation(internal.inbound.sms, { to: NUMBER, from: "+15125550171", body: "Hello", receivedAt: Date.now() })).toMatchObject({ kind: "unknown_number" });

    // The next month, and the daily carrier check: no fee is posted, and nothing switches texts back on.
    vi.setSystemTime(Date.UTC(2026, 11, 2, 15));
    await s.t.mutation(internal.texting.chargeNumbers, {});
    await s.t.mutation(internal.texting.activeChecked, { requestId: s.requestId, stopped: false, status: "MNO_PROVISIONED ACTIVE" });
    expect(await s.fees()).toEqual([`Texting number ${NUMBER}, 2026-11`, "Texting registration, 2026-11"]);
    expect((await s.row()).status).toBe("released");
    expect((await s.as.query(api.compliance.profile, { companyId: s.companyId })).messaging.registration.status).toBe("not_started");
  });

  it("stops at a step that fails, says why, and continues from there without repeating anything", async () => {
    let broken = true;
    const s = await active({ refuse: (call) => broken && call.startsWith("DELETE /phone_numbers/") });
    await s.as.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "release", acknowledgement: RELEASE_WORDING });
    await s.admin.mutation(api.texting.releaseNumber, { requestId: s.requestId });
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const stopped = await s.row();
    // Not released: the request says exactly where it stopped, and texts are already off because the number left its campaign.
    expect(stopped.status).toBe("active");
    expect(stopped.offboarding?.problem).toContain("Deleting the number at Telnyx");
    expect(stopped.offboarding?.unassignedAt).toBeTypeOf("number");
    expect(stopped.offboarding?.numberRemovedAt).toBeUndefined();
    expect((await s.as.query(api.compliance.profile, { companyId: s.companyId })).messaging.registration.status).toBe("not_started");
    expect((await s.admin.query(api.texting.queue, {})).find((row) => row.requestId === s.requestId)?.offboarding).toMatchObject({ route: "release", problem: expect.stringContaining("Deleting the number") });

    broken = false;
    expect(await s.admin.mutation(api.texting.releaseNumber, { requestId: s.requestId })).toBe("started");
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await s.row()).status).toBe("released");
    expect(s.deletes()).toEqual([`DELETE /10dlc/phone_number_campaigns/${NUMBER}`, "DELETE /phone_numbers/num-0142", "DELETE /phone_numbers/num-0142", "DELETE /10dlc/campaign/campaign-1"]);
  });

  it("changes nothing at Telnyx from a backend that is not production", async () => {
    const s = await active();
    await s.as.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "release", acknowledgement: RELEASE_WORDING });
    process.env.CONVEX_CLOUD_URL = "https://quiet-otter-123.convex.cloud";
    await s.admin.mutation(api.texting.releaseNumber, { requestId: s.requestId });
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    delete process.env.CONVEX_CLOUD_URL;
    const row = await s.row();
    expect(row.status).toBe("active");
    expect(row.offboarding?.problem).toContain("not the production backend");
    expect(s.deletes()).toEqual([]);
    expect((await s.as.query(api.compliance.profile, { companyId: s.companyId })).messaging).toMatchObject({ smsNumber: NUMBER, registration: { status: "approved" } });
  });

  it("closes a transfer only once the number has really left, and never releases it meanwhile", async () => {
    let ported = false;
    const s = await active({ portedOut: () => ported });
    expect(await refusal(s.admin.mutation(api.texting.completeTransfer, { requestId: s.requestId }))).toContain("hasn't said");
    await s.as.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "port_out", acknowledgement: PORT_OUT_WORDING });
    expect((await s.item())[0]).toMatchObject({ state: "waiting_provider", assisted: { route: "port_out", phoneNumber: NUMBER } });

    // Marked complete too early: Telnyx still has the number, so nothing changes.
    await s.admin.mutation(api.texting.completeTransfer, { requestId: s.requestId });
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const early = await s.row();
    expect(early.status).toBe("active");
    expect(early.offboarding?.problem).toContain("still on Selestial's Telnyx account");
    expect(s.deletes()).toEqual([]);
    expect((await s.as.query(api.compliance.profile, { companyId: s.companyId })).messaging).toMatchObject({ smsNumber: NUMBER, registration: { status: "approved" } });

    ported = true;
    await s.admin.mutation(api.texting.completeTransfer, { requestId: s.requestId });
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await s.row()).status).toBe("released");
    // The number was never deleted by Selestial: only the campaign it no longer needs.
    expect(s.deletes()).toEqual(["DELETE /10dlc/campaign/campaign-1"]);
    expect((await s.t.run(async (ctx) => ctx.db.query("events").collect())).map((row) => row.type)).toContain("texting.transfer_completed");
    expect((await s.as.query(api.compliance.profile, { companyId: s.companyId })).messaging.smsNumber).toBeUndefined();
  });

  it("opens a staff work item when the plan is cancelled, which releases nothing without the owner", async () => {
    const s = await active();
    expect((await s.t.run((ctx) => ctx.db.get(s.companyId)))?.plan).toBeTruthy();
    // The plan ends (the owner's cancellation taking effect, or 30 days unpaid): Autumn reports no plan.
    billing.seed(s.companyId, { plan: null });
    await s.t.action(internal.billing.syncCompany, { companyId: s.companyId });
    expect((await s.t.run((ctx) => ctx.db.get(s.companyId)))?.plan).toBeUndefined();
    expect(await s.item()).toHaveLength(1);
    // A second sync, or the unpaid-plan path arriving as well, opens nothing more for the same number.
    await s.t.action(internal.billing.syncCompany, { companyId: s.companyId });
    await s.t.run((ctx) => openPlanCancelledWork(ctx, s.companyId, "unpaid"));
    const items = await s.item();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: "waiting_selestial", assignee: { kind: "staff" }, assisted: { route: "release", phoneNumber: NUMBER, source: "plan_cancelled" } });
    expect(items[0].assisted?.authorization).toBeUndefined();
    expect((await s.admin.query(api.texting.queue, {})).map((row) => row.requestId)).toContain(s.requestId);
    // It is only a work item: the number works, and staff cannot release on the strength of it.
    expect((await s.row()).status).toBe("active");
    expect(await refusal(s.admin.mutation(api.texting.releaseNumber, { requestId: s.requestId }))).toContain("hasn't authorized");
    expect(s.deletes()).toEqual([]);
    // The owner was not told they asked for anything.
    expect(await s.t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((row) => row.notice?.facts?.kind === "release_requested").length)).toBe(0);

    // The owner's own request turns that same item into an authorized one; cancelling takes only the authorization back.
    const id = await s.as.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "release", acknowledgement: RELEASE_WORDING });
    expect(id).toBe(items[0]._id);
    await s.as.mutation(api.textingCase.cancelOffboarding, { companyId: s.companyId, exceptionId: id });
    const [after] = await s.item();
    expect(after.state).toBe("waiting_selestial");
    expect(after.assisted?.authorization).toBeUndefined();
    await s.as.mutation(api.textingCase.requestOffboarding, { companyId: s.companyId, route: "release", acknowledgement: RELEASE_WORDING });
    await s.admin.mutation(api.texting.releaseNumber, { requestId: s.requestId });
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await s.row()).status).toBe("released");
  });
});
