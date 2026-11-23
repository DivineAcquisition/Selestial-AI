/**
 * @vitest-environment edge-runtime
 *
 * The guided cleaner onboarding, end to end through the real functions: a company invites a cleaner, the
 * cleaner works through each step from their link, the office does its part, and the cleaner's page, the
 * owner's view, reminders and Dispatch agree at every point.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, dispatchCleaner, dispatchJob, dispatchPlace, readyMessaging, refusal, start, withLinkSecret, type T } from "../tests/harness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mockOutbox } from "./lib/messaging/provider";
import { NOT_ALLOWED, NOT_FOUND } from "./lib/errors";

const DAY = 24 * 60 * 60 * 1000;
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const tokenOf = (url: string) => url.split("/c/portal/")[1];
const TAX_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256)));

beforeEach(() => {
  process.env.TAX_ID_KEY = TAX_KEY;
  process.env.MESSAGING_PROVIDER = "mock";
  mockOutbox.length = 0;
});
afterEach(() => {
  delete process.env.TAX_ID_KEY;
  delete process.env.MESSAGING_PROVIDER;
  vi.useRealTimers();
});

async function setup(phone = "+15125550101") {
  const t = start();
  const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
  const { cleanerId } = await as.mutation(api.workforce.add, { companyId, person: { name: "Rosa Diaz", engagement: "contractor", phone, email: "rosa@example.com", serviceAreas: ["78701"] } });
  return { t, as, companyId, cleanerId };
}
type S = Awaited<ReturnType<typeof setup>>;

async function portalFor(s: S) {
  const { linkId } = (await s.as.mutation(api.portalAccess.invite, { companyId: s.companyId, cleanerId: s.cleanerId })) as { linkId: Id<"portalLinks"> };
  const { url } = await s.as.mutation(api.portalAccess.reveal, { companyId: s.companyId, linkId });
  return { linkId, token: tokenOf(url) };
}

/** The company's contractor agreement for Rosa, drafted, approved by the Owner and sent for signature in Selestial. */
async function sendAgreement(s: S) {
  const id = await s.as.mutation(api.companyAgreements.create, { companyId: s.companyId, docType: "contractor_agreement", links: [{ table: "cleaners", id: s.cleanerId }] });
  let d = await s.as.query(api.companyAgreements.get, { companyId: s.companyId, agreementId: id });
  const answered = await s.as.mutation(api.companyAgreements.answer, {
    companyId: s.companyId,
    agreementId: id,
    baseVersion: d.currentVersion,
    answers: { roleTitle: "House cleaning", workLocation: "Client homes in Austin", engagementStart: "2027-03-01", governingState: "TX", setsOwnSchedule: true, ownEquipment: true, responsibilities: "Residential cleaning to the job's checklist.", payBasis: "share of job price", payRateText: "45% of each job's price", payFrequency: "Weekly", equipmentIssued: ["None"], returnDays: 7, companySigner: "Owner A, Owner", counterpartySigner: "Rosa Diaz, herself" },
  });
  if (!answered.ok) throw new Error(JSON.stringify(answered));
  d = await s.as.query(api.companyAgreements.get, { companyId: s.companyId, agreementId: id });
  await s.as.mutation(api.companyAgreements.setParties, { companyId: s.companyId, agreementId: id, parties: d.parties.map((p) => (p.role === "company" ? { ...p, name: "Owner A", email: "owner-a@example.com" } : p)) });
  d = await s.as.query(api.companyAgreements.get, { companyId: s.companyId, agreementId: id });
  await s.as.mutation(api.companyAgreements.approveVersion, { companyId: s.companyId, agreementId: id, version: d.currentVersion, hash: d.version.hash, acknowledgeSkipped: true });
  await s.as.mutation(api.agreementSigning.send, { companyId: s.companyId, agreementId: id });
  await settle(s.t);
  return id;
}

const lastCode = (to: string) => /(\d{6})/.exec(mockOutbox.filter((row) => row.to === to).at(-1)!.body)![1];
const view = (s: S, token: string) => s.t.query(api.cleanerOnboarding.view, { token, asOf: Date.now() });
const stepStates = async (s: S, token: string) => Object.fromEntries((await view(s, token))!.journey.steps.map((step) => [step.id, step.state]));

describe("the guided cleaner onboarding", () => {
  it("takes an invited cleaner through every step without uploading a file, and the office and Dispatch agree", async () => {
    await withLinkSecret(async () => {
      vi.useFakeTimers();
      const s = await setup();
      await readyMessaging(s.t, s.companyId);
      const { token, linkId } = await portalFor(s);

      // The invitation opens one guided sequence: numbered steps, no upload, no tax-form step.
      let v = (await view(s, token))!;
      expect(v.company.name).toBe("Alpha Cleaning");
      expect(v.journey.steps.map((step) => [step.number, step.type, step.id])).toEqual([
        [1, "signature", "agreement"],
        [2, "contact_verification", "contact"],
        [3, "checklist", "equipment"],
        [4, "guide_acknowledgment", "job_day"],
        [5, "guide_acknowledgment", "policies"],
        [6, "payment_setup", "payment_setup"],
        [7, "training", "training"],
      ]);
      expect(v.journey.steps.some((step) => step.type === "document_upload")).toBe(false);
      expect(v.journey.steps.find((step) => step.id === "payment_setup")).toMatchObject({ locked: true, keys: ["payment_setup", "tax_form"] });
      // The agreement has not been sent, so it is the office's move, not a task for Rosa.
      expect(v.journey.steps[0].state).toBe("waiting_on_office");
      expect(v.journey).toMatchObject({ state: "in_progress", next: "contact", finished: 0, total: 7 });
      // Opening the page changed nothing.
      expect((await s.t.run((ctx) => ctx.db.get(linkId)))!.lastActionAt).toBeUndefined();

      // Step 1: the Owner sends the contractor agreement; Rosa reads the exact approved text and signs it.
      await sendAgreement(s);
      v = (await view(s, token))!;
      expect(v.agreement).toMatchObject({ canSign: true, hosted: true, signedAt: null, role: "Independent contractor" });
      expect(v.agreement!.markdown).toContain("45% of each job's price");
      expect(v.journey.steps[0].state).toBe("todo");
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.signAgreement, { token, typedName: "Rosa Diaz", hash: "0".repeat(64), agreed: true }))).toContain("changed since you opened it");
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.signAgreement, { token, typedName: "Rosa Diaz", hash: v.agreement!.hash!, agreed: false }))).toContain("Check the box");
      expect(await s.t.mutation(api.cleanerOnboarding.signAgreement, { token, typedName: "Rosa Diaz", hash: v.agreement!.hash!, agreed: true })).toEqual({ complete: false });
      // Her part is done; the company's signature is outstanding, so it is with the office and not yet met.
      expect((await stepStates(s, token)).agreement).toBe("office_review");
      let office = await s.as.query(api.onboardingSetup.forCleaner, { companyId: s.companyId, cleanerId: s.cleanerId, asOf: Date.now() });
      expect(office.agreement).toMatchObject({ youCanCountersign: true });
      expect(office.journey.steps[0].state).toBe("office_review");
      const { url } = await s.as.mutation(api.onboardingSetup.countersignLink, { companyId: s.companyId, cleanerId: s.cleanerId });
      const signToken = url.split("/c/sign/")[1];
      const signView = (await s.t.query(api.sign.view, { token: signToken }))!;
      await s.t.mutation(api.sign.signNow, { token: signToken, typedName: "Owner A", hash: signView.hash!, agreed: true });
      await settle(s.t);
      expect((await stepStates(s, token)).agreement).toBe("done");
      const copy = (await s.t.query(api.cleanerOnboarding.signedCopy, { token }))!;
      expect(copy).toMatchObject({ complete: true });
      expect(copy.signatures.map((row) => row.typedName)).toEqual(["Owner A", "Rosa Diaz"]);

      // Step 2: a wrong code, then the right one, to a corrected number. Possession is proved; consent is separate.
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.sendPhoneCode, { token, phone: "12" }))).toContain("mobile number");
      expect(await s.t.mutation(api.cleanerOnboarding.sendPhoneCode, { token, phone: "(512) 555-0177" })).toEqual({ sentTo: "•••0177" });
      await settle(s.t);
      const code = lastCode("+15125550177");
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.verifyPhone, { token, code: code === "000000" ? "111111" : "000000" }))).toContain("not right");
      await s.t.mutation(api.cleanerOnboarding.verifyPhone, { token, code });
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.verifyPhone, { token, code }))).toContain("expired");
      const rosa = (await s.t.run((ctx) => ctx.db.get(s.cleanerId)))!;
      expect(rosa.phone).toBe("+15125550177");
      expect(rosa.phoneVerified?.phone).toBe("+15125550177");
      // Verifying did not grant work texts: that is the cleaner's own separate choice.
      expect(await s.t.run((ctx) => ctx.db.query("permissions").collect())).toEqual([]);
      await s.t.mutation(api.portal.setAvailability, { token, windows: [{ weekday: 2, startMinute: 480, endMinute: 1020 }] });
      v = (await view(s, token))!;
      expect(v.verified).toBe(true);
      expect(v.journey.steps[1].state).toBe("done");

      // Step 3: a truthful checklist with missing supplies completes the step.
      const items = v.supplies!.items.filter((item) => item.provider === "cleaner");
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.submitSupplies, { token, answers: { vacuum: "have" } }))).toContain("Answer every item");
      const answers = Object.fromEntries(items.map((item) => [item.id, item.id === "vacuum" || item.id === "floor_machine" ? "missing" : "have"])) as Record<string, "have" | "missing">;
      expect(await s.t.mutation(api.cleanerOnboarding.submitSupplies, { token, answers })).toEqual({ have: items.length - 2, missing: 2 });
      expect((await stepStates(s, token)).equipment).toBe("done");

      // Steps 4 and 5: opening a guide records nothing; only an explicit agreement to the exact content does.
      for (const guide of v.guides) {
        expect(await refusal(s.t.mutation(api.cleanerOnboarding.acknowledgeGuide, { token, key: guide.key, hash: guide.hash!, agreed: false }))).toContain("Tick the box");
        expect(await refusal(s.t.mutation(api.cleanerOnboarding.acknowledgeGuide, { token, key: guide.key, hash: "stale", agreed: true }))).toContain("changed since the page opened");
        await s.t.mutation(api.cleanerOnboarding.acknowledgeGuide, { token, key: guide.key, hash: guide.hash!, agreed: true });
      }
      expect(await stepStates(s, token)).toMatchObject({ job_day: "done", policies: "done" });

      // Step 6: a pay preference among the company's supported methods, then the background tax document.
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.setPayout, { token, method: "venmo", handle: "@rosa-diaz" }))).toContain("ways the company pays");
      await s.t.mutation(api.cleanerOnboarding.setPayout, { token, method: "zelle", handle: "rosa@example.com" });
      v = (await view(s, token))!;
      // The preference is recorded, not enabled, and the tax document still needs her: the step stays hers.
      expect(v.payment.current).toMatchObject({ method: "zelle", status: "recorded" });
      expect(v.payment.tax).toMatchObject({ form: "w9", status: "awaiting_information", needsWorker: true, legalName: "Rosa Diaz" });
      expect(v.journey.steps[5].state).toBe("todo");
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.saveTaxInfo, { token, legalName: "Rosa Diaz", tinType: "ssn", tin: "000-12-3456", line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701" }))).toContain("does not look right");
      expect(await s.t.mutation(api.cleanerOnboarding.saveTaxInfo, { token, legalName: "Rosa Diaz", tinType: "ssn", tin: "123-45-6789", line1: "1 Main St", city: "Austin", state: "tx", postalCode: "78701" })).toEqual({ tinLast4: "6789" });
      expect((await view(s, token))!.payment.tax).toMatchObject({ status: "awaiting_confirmation", needsWorker: true, tinLast4: "6789" });
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.certifyTax, { token, typedName: "Someone Else", agreed: true }))).toContain("legal name");
      await s.t.mutation(api.cleanerOnboarding.certifyTax, { token, typedName: "rosa diaz", agreed: true });
      // Preparing is not completed: the requirement is not met until the document exists.
      let profile = await s.as.query(api.cleanerProfile.profile, { companyId: s.companyId, cleanerId: s.cleanerId, asOf: Date.now() });
      expect(profile.readiness.paymentBlockers.map((row) => row.key).sort()).toEqual(["payment_setup", "tax_form"]);
      expect((await stepStates(s, token)).payment_setup).toBe("office_review");
      await settle(s.t);
      office = await s.as.query(api.onboardingSetup.forCleaner, { companyId: s.companyId, cleanerId: s.cleanerId, asOf: Date.now() });
      expect(office.tax).toMatchObject({ status: "completed", hasDocument: true, tinLast4: "6789" });
      expect((await s.as.mutation(api.onboardingSetup.taxDocument, { companyId: s.companyId, cleanerId: s.cleanerId })).url).toBeTruthy();
      // Finance confirms the preference; only now does it count.
      const manager = await addMember(s.t, s.as, s.companyId, "manager-a", "manager");
      expect(await refusal(manager.mutation(api.onboardingSetup.confirmPayout, { companyId: s.companyId, cleanerId: s.cleanerId }))).toBe(NOT_ALLOWED);
      expect((await manager.query(api.onboardingSetup.forCleaner, { companyId: s.companyId, cleanerId: s.cleanerId, asOf: Date.now() })).tax).toMatchObject({ tinLast4: null, legalName: null });
      await s.as.mutation(api.onboardingSetup.confirmPayout, { companyId: s.companyId, cleanerId: s.cleanerId });
      expect((await stepStates(s, token)).payment_setup).toBe("done");

      // Step 7: training completes only by reading in order and answering correctly.
      v = (await view(s, token))!;
      const module = v.training.modules[0];
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.readSection, { token, moduleKey: module.key, index: 2 }))).toContain("in order");
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.readSection, { token, moduleKey: module.key, index: 0, answer: 0 }))).toContain("Not quite");
      expect((await stepStates(s, token)).training).toBe("todo");
      const answersFor = [1, 1, undefined, 1];
      for (let i = 0; i < module.sections!.length; i += 1) await s.t.mutation(api.cleanerOnboarding.readSection, { token, moduleKey: module.key, index: i, answer: answersFor[i] });
      expect((await stepStates(s, token)).training).toBe("done");

      // Every step is hers and finished. The office makes the engagement active; Rosa is then ready.
      v = (await view(s, token))!;
      expect(v.journey).toMatchObject({ state: "steps_finished", finished: 7, total: 7, next: null, actionable: [] });
      office = await s.as.query(api.onboardingSetup.forCleaner, { companyId: s.companyId, cleanerId: s.cleanerId, asOf: Date.now() });
      expect(office.journey.steps.map((step) => [step.id, step.state])).toEqual(v.journey.steps.map((step) => [step.id, step.state]));
      expect(office.supplies?.missing).toEqual(["Vacuum with attachments", "Floor scrubber or buffer"]);
      await s.as.mutation(api.cleanerProfile.setEngagementStatus, { companyId: s.companyId, cleanerId: s.cleanerId, status: "ready" });
      expect((await view(s, token))!.journey.state).toBe("ready");
      profile = await s.as.query(api.cleanerProfile.profile, { companyId: s.companyId, cleanerId: s.cleanerId, asOf: Date.now() });
      expect(profile.readiness).toMatchObject({ state: "ready", eligible: true, payoutReady: true });

      // Nothing was uploaded, and the taxpayer number is nowhere but sealed on its own row.
      const rows = await s.t.run((ctx) => ctx.db.query("workerRequirements").collect());
      expect(rows.every((row) => !row.evidence?.files?.length)).toBe(true);
      const everything = JSON.stringify(await s.t.run(async (ctx) => ({ events: await ctx.db.query("events").collect(), messages: await ctx.db.query("messages").collect(), tasks: await ctx.db.query("tasks").collect(), cleaners: await ctx.db.query("cleaners").collect(), requirements: rows })));
      expect(everything).not.toContain("123456789");
      expect(everything).not.toContain("45-6789");
      const doc = (await s.t.run((ctx) => ctx.db.query("taxDocuments").first()))!;
      expect(doc.tinSealed).not.toContain("6789");
    });
  });

  it("keeps progress across reopening, and a republished guide is asked again only when the Owner decides", async () => {
    await withLinkSecret(async () => {
      const s = await setup();
      const first = await portalFor(s);
      const guide = (await view(s, first.token))!.guides.find((row) => row.key === "job_day")!;
      await s.t.mutation(api.cleanerOnboarding.acknowledgeGuide, { token: first.token, key: "job_day", hash: guide.hash!, agreed: true });
      // A newer link (resent, or another device) shows the same progress: it is kept on the record, not the link.
      await s.as.mutation(api.portalAccess.revoke, { companyId: s.companyId, linkId: first.linkId });
      expect(await view(s, first.token)).toBeNull();
      const second = await portalFor(s);
      expect((await stepStates(s, second.token)).job_day).toBe("done");

      const setup1 = await s.as.query(api.onboardingSetup.get, { companyId: s.companyId });
      const edited = { ...setup1.published.content, jobGuide: { ...setup1.published.content.jobGuide, intro: "Every job, start to finish. Updated." } };
      await s.as.mutation(api.onboardingSetup.saveDraft, { companyId: s.companyId, content: edited });
      expect((await s.as.query(api.onboardingSetup.get, { companyId: s.companyId })).changed).toEqual([{ key: "job_day", label: "How your jobs work" }]);
      // A wording fix: nobody is asked again.
      expect(await s.as.mutation(api.onboardingSetup.publish, { companyId: s.companyId, again: [] })).toMatchObject({ version: 1, changes: [{ key: "job_day", again: false }] });
      expect((await stepStates(s, second.token)).job_day).toBe("done");
      // A new rule: the Owner asks everyone who agreed to agree again. Only that step reopens; evidence stays.
      const later = { ...edited, jobGuide: { ...edited.jobGuide, sections: [...edited.jobGuide.sections, { title: "Keys", body: "Return client keys the same day." }] } };
      await s.as.mutation(api.onboardingSetup.saveDraft, { companyId: s.companyId, content: later });
      await s.as.mutation(api.onboardingSetup.publish, { companyId: s.companyId, again: ["job_day"] });
      expect(await stepStates(s, second.token)).toMatchObject({ job_day: "todo", policies: "todo" });
      const profile = await s.as.query(api.cleanerProfile.profile, { companyId: s.companyId, cleanerId: s.cleanerId, asOf: Date.now() });
      expect(profile.readiness.blockers.map((row) => row.key)).toContain("job_day");
      const row = (await s.t.run((ctx) => ctx.db.query("workerRequirements").filter((q) => q.eq(q.field("key"), "job_day")).first()))!;
      expect(row.acknowledged?.version).toBe(0);
      const fresh = (await view(s, second.token))!.guides.find((g) => g.key === "job_day")!;
      expect(fresh.sections.at(-1)?.title).toBe("Keys");
      await s.t.mutation(api.cleanerOnboarding.acknowledgeGuide, { token: second.token, key: "job_day", hash: fresh.hash!, agreed: true });
      expect((await stepStates(s, second.token)).job_day).toBe("done");
      // Only the Owner publishes.
      const manager = await addMember(s.t, s.as, s.companyId, "manager-a", "manager");
      expect(await refusal(manager.mutation(api.onboardingSetup.publish, { companyId: s.companyId, again: [] }))).toBe(NOT_ALLOWED);
    });
  });

  it("refuses expired, revoked, wrong-company and out-of-scope links, keeps older links working, and ends with the engagement", async () => {
    await withLinkSecret(async () => {
      const s = await setup();
      const { token, linkId } = await portalFor(s);
      const guide = (await view(s, token))!.guides[0];

      // An older full-portal link, issued before the onboarding actions existed, still takes them.
      await s.t.run((ctx) => ctx.db.patch(linkId, { allowed: ["confirm_contact", "submit_requirement", "set_availability", "acknowledge", "request_code", "verify_code", "ask_for_help"] }));
      await s.t.mutation(api.cleanerOnboarding.acknowledgeGuide, { token, key: guide.key, hash: guide.hash!, agreed: true });

      // A task link for the supplies step opens that step only.
      const task = await s.t.run(async (ctx) => {
        const { issuePortalLink, portalTokenFor } = await import("./lib/cleaners/portal");
        const link = await issuePortalLink(ctx, { companyId: s.companyId, holder: { cleanerId: s.cleanerId }, purpose: "task", requirementKey: "equipment", expiresAt: Date.now() + DAY, issuedBy: { kind: "system" }, actor: { kind: "system" } });
        return portalTokenFor(link!);
      });
      expect((await view(s, task!))!.focus).toBe("equipment");
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.sendPhoneCode, { token: task!, phone: "+15125550101" }))).toBe("This link is for a different step.");
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.acknowledgeGuide, { token: task!, key: "policies", hash: "x", agreed: true }))).toBe("This link is for a different step.");
      expect(await refusal(s.t.mutation(api.portal.claimSkill, { token: task!, skill: "windows" }))).toBe(NOT_ALLOWED);
      // A check-in link has no onboarding actions at all.
      const checkIn = await s.t.run(async (ctx) => {
        const { issuePortalLink, portalTokenFor } = await import("./lib/cleaners/portal");
        const link = await issuePortalLink(ctx, { companyId: s.companyId, holder: { cleanerId: s.cleanerId }, purpose: "check_in", expiresAt: Date.now() + DAY, issuedBy: { kind: "system" }, actor: { kind: "system" } });
        return portalTokenFor(link!);
      });
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.submitSupplies, { token: checkIn!, answers: {} }))).toBe(NOT_ALLOWED);
      // Pay and tax need the one-time code first, even on a full link.
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.setPayout, { token, method: "zelle", handle: "rosa@example.com" }))).toContain("verify with a code");
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.saveTaxInfo, { token, legalName: "Rosa Diaz", tinType: "ssn", tin: "123456789", line1: "1 Main", city: "Austin", state: "TX", postalCode: "78701" }))).toContain("verify with a code");

      // Expired and revoked links see nothing and change nothing.
      await s.t.run((ctx) => ctx.db.patch(linkId, { expiresAt: Date.now() - 1 }));
      expect(await view(s, token)).toBeNull();
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.acknowledgeGuide, { token, key: guide.key, hash: guide.hash!, agreed: true }))).toContain("expired");
      const live = await portalFor(s);
      await s.as.mutation(api.portalAccess.revoke, { companyId: s.companyId, linkId: live.linkId });
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.submitSupplies, { token: live.token, answers: {} }))).toBe("This link is no longer active.");
      // A tampered token, and a link whose cleaner belongs to another company, are "Not found.".
      expect(await refusal(s.t.query(api.cleanerOnboarding.view, { token: `${live.token.slice(0, -2)}xx`, asOf: Date.now() }))).toBe(NOT_FOUND);
      const other = await company(s.t, "owner-b", "Beta Cleaning");
      const { cleanerId: betaCleaner } = await other.as.mutation(api.workforce.add, { companyId: other.companyId, person: { name: "Ben Ortiz", engagement: "contractor", phone: "+15125550190" } });
      const crossed = await portalFor(s);
      await s.t.run((ctx) => ctx.db.patch(crossed.linkId, { cleanerId: betaCleaner }));
      expect(await refusal(s.t.query(api.cleanerOnboarding.view, { token: crossed.token, asOf: Date.now() }))).toBe(NOT_FOUND);

      // An ended engagement keeps its history; its links change nothing more.
      const last = await portalFor(s);
      await s.t.run((ctx) => ctx.db.patch(s.cleanerId, { status: "ended" }));
      expect(await view(s, last.token)).toBeNull();
      expect(await refusal(s.t.mutation(api.cleanerOnboarding.acknowledgeGuide, { token: last.token, key: "policies", hash: "x", agreed: true }))).toContain("ended");
    });
  });

  it("counts a video as watched only when it played to the end, never by skipping ahead", async () => {
    await withLinkSecret(async () => {
      vi.useFakeTimers();
      const s = await setup();
      const current = (await s.as.query(api.onboardingSetup.get, { companyId: s.companyId })).published.content;
      await s.as.mutation(api.onboardingSetup.saveDraft, { companyId: s.companyId, content: { ...current, training: { modules: [{ key: "welcome", title: "Welcome video", kind: "video", required: true, videoUrl: "https://videos.example.com/welcome.mp4" }] } } });
      await s.as.mutation(api.onboardingSetup.publish, { companyId: s.companyId, again: [] });
      const { token } = await portalFor(s);
      await s.t.mutation(api.cleanerOnboarding.startModule, { token, moduleKey: "welcome" });
      // Jumping to the end right away is not watching it.
      let result = await s.t.mutation(api.cleanerOnboarding.videoProgress, { token, moduleKey: "welcome", position: 120, duration: 120 });
      expect(result).toMatchObject({ completed: false });
      expect(result.watchedSeconds).toBeLessThan(10);
      expect((await stepStates(s, token)).training).toBe("todo");
      // Watching in order, at normal speed, to the end.
      for (let at = 20; at <= 120; at += 20) {
        vi.setSystemTime(Date.now() + 20_000);
        result = await s.t.mutation(api.cleanerOnboarding.videoProgress, { token, moduleKey: "welcome", position: at, duration: 120 });
      }
      expect(result).toMatchObject({ completed: true, trainingDone: true });
      expect((await stepStates(s, token)).training).toBe("done");
    });
  });

  it("Dispatch holds a visit back from someone missing a required supply only when the company's rule says so", async () => {
    const s = await setup();
    const anaId = await dispatchCleaner(s.as, s.companyId, "Ana Ruiz");
    const items = (await s.as.query(api.onboardingSetup.get, { companyId: s.companyId })).published.content.supplies.items.filter((item) => item.provider === "cleaner");
    const answers = Object.fromEntries(items.map((item) => [item.id, item.id === "vacuum" ? "missing" : "have"])) as Record<string, "have" | "missing">;
    await s.t.run((ctx) => ctx.db.insert("workerRequirements", { companyId: s.companyId, cleanerId: anaId, key: "equipment", status: "accepted", evidence: { supplies: answers }, acknowledged: { words: "supplies checklist", at: Date.now(), version: 0 }, updatedAt: Date.now() }));
    const place = await dispatchPlace(s.as, s.companyId);
    const eligible = async (key: string) => {
      const jobId = await dispatchJob(s.as, s.companyId, place);
      const run = (await s.t.mutation(internal.dispatchTools.run, { companyId: s.companyId, tool: "find_eligible_cleaners", input: { jobId }, idempotencyKey: key })) as unknown as { result: { candidates: { name: string }[]; excluded: { name: string; reasons: string[] }[] } };
      return run.result;
    };
    // Advisory, the default: completing the checklist truthfully does not stop her being offered work.
    expect((await eligible("a1")).candidates.map((row) => row.name)).toContain("Ana Ruiz");
    const content = (await s.as.query(api.onboardingSetup.get, { companyId: s.companyId })).published.content;
    await s.as.mutation(api.onboardingSetup.saveDraft, { companyId: s.companyId, content: { ...content, supplies: { ...content.supplies, rule: "required_for_visit" } } });
    await s.as.mutation(api.onboardingSetup.publish, { companyId: s.companyId, again: [] });
    // Required for the visit: a standard clean needs a vacuum she said she does not have.
    const held = await eligible("a2");
    expect(held.candidates.map((row) => row.name)).not.toContain("Ana Ruiz");
    expect(JSON.stringify(held.excluded)).toContain("supplies for this visit (vacuum with attachments)");
  });

  it("marks a company that already had cleaners on the earlier template, and never shows its tax form as an upload", async () => {
    await withLinkSecret(async () => {
      const s = await setup();
      await s.t.run((ctx) => ctx.db.patch(s.companyId, { cleaners: { startingTemplate: "v1" } }));
      const { cleanerId } = await s.as.mutation(api.workforce.add, { companyId: s.companyId, person: { name: "Ana Ruiz", engagement: "contractor", phone: "+15125550133", email: "ana@example.com" } });
      const { linkId } = (await s.as.mutation(api.portalAccess.invite, { companyId: s.companyId, cleanerId })) as { linkId: Id<"portalLinks"> };
      const { url } = await s.as.mutation(api.portalAccess.reveal, { companyId: s.companyId, linkId });
      const v = (await s.t.query(api.cleanerOnboarding.view, { token: tokenOf(url), asOf: Date.now() }))!;
      // The earlier template's identity documents remain a genuine upload step; the tax form is inside pay.
      expect(v.journey.steps.filter((step) => step.type === "document_upload").map((step) => step.id)).toEqual(["documents"]);
      expect(v.journey.steps.find((step) => step.type === "payment_setup")?.keys).toEqual(["payment_setup", "tax_form"]);
      // The Owner can move to the guided template; Ana keeps her records and is not given new steps by surprise.
      await s.as.mutation(api.onboardingSetup.useGuided, { companyId: s.companyId });
      const after = (await s.t.query(api.cleanerOnboarding.view, { token: tokenOf(url), asOf: Date.now() }))!;
      expect(after.journey.steps.map((step) => step.id)).not.toContain("job_day");
      void internal;
    });
  });
});
