/**
 * @vitest-environment edge-runtime
 *
 * The texting onboarding case (docs/texting/02-case.md): evidence and notes, recommendations, exceptions,
 * versioned configuration, number journeys, support sessions, tutorials and imports. Telnyx is faked; no
 * number is bought and nothing is filed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, refusal, staffWith, start, type T } from "../tests/harness";
import { ADMIN } from "../tests/trustHarness";
import { fakeTelnyx, KEY, prepare, revision, settle, submit, type As } from "../tests/textingHarness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { parseConfig } from "./lib/texting/config";
import { checkEvidenceFile, REVIEW_COPY_WORDING } from "./lib/texting/evidence";
import { findings } from "./lib/texting/recommend";
import { WRITTEN_CRITERIA } from "./lib/tutorials/catalog";
import { PORT_WORDING } from "./textingCase";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const SECOND_ADMIN = { subject: "user_admin_two", email: "second@selestial.example", emailVerified: true, name: "Second Admin" };
const SUPPORT = { subject: "user_admin", email: ADMIN.email, emailVerified: true, name: "Boss", fva: [1, 1] };
const BAD_CONSENT = "Alpha Cleaning texts you about your cleanings.";

async function upload(t: T, bytes: Uint8Array, type: string) {
  return t.run((ctx) => ctx.storage.store(new Blob([bytes as BlobPart], { type })));
}

async function addFile(t: T, as: As, companyId: Id<"companies">, extra: Record<string, unknown> = {}) {
  const storageId = await upload(t, PNG, "image/png");
  const added = await as.mutation(api.textingCase.addEvidence, { companyId, purpose: "opt_in_screenshot", describes: "Our booking form with the text box", storageId, name: "booking.png", place: "booking_form", ...extra });
  await settle(t);
  return added;
}

async function workspace(as: As, companyId: Id<"companies">) {
  return (await as.query(api.textingCase.workspace, { companyId }))!;
}

/** A support session in Manage mode, under the owner's grant. */
async function manageSession(t: T, owner: As, companyId: Id<"companies">) {
  const staff = t.withIdentity(SUPPORT);
  const sessionId = await staff.mutation(api.support.start, { companyId, reason: "Helping with texting evidence" });
  await owner.mutation(api.support.grantManage, { companyId, hours: 4 });
  await staff.mutation(api.support.switchToManage, { sessionId, reason: "Correct texting evidence and notes" });
  return { staff, sessionId };
}

describe("Texting onboarding case", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.TELNYX_API_KEY = "KEY_test";
    process.env.MAILBOX_TOKEN_KEY = KEY;
    process.env.STAFF_BOOTSTRAP_EMAIL = ADMIN.email;
    process.env.TELNYX_WEBHOOK_URL = "https://deployment.convex.site.test";
    process.env.SUPPORT_ACCESS = "on";
    vi.stubGlobal("fetch", fakeTelnyx().fetcher);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const name of ["TELNYX_API_KEY", "MAILBOX_TOKEN_KEY", "STAFF_BOOTSTRAP_EMAIL", "TELNYX_WEBHOOK_URL", "SUPPORT_ACCESS", "ACTION_LINK_SECRET", "CONVEX_SITE_URL"]) delete process.env[name];
  });

  it("checks evidence files by their own bytes and size, not their name", () => {
    expect(checkEvidenceFile({ name: "a.png", contentType: "image/png", size: 100, head: PNG })).toEqual({ ok: true, contentType: "image/png" });
    expect(checkEvidenceFile({ name: "a.png", contentType: "image/png", size: 100, head: new Uint8Array([0x25, 0x50, 0x44, 0x46]) })).toMatchObject({ ok: false });
    expect(checkEvidenceFile({ name: "a.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 100, head: new Uint8Array([0x50, 0x4b, 3, 4]) })).toMatchObject({ ok: false });
    expect(checkEvidenceFile({ name: "a.pdf", contentType: "application/pdf", size: 11 * 1024 * 1024, head: new Uint8Array([0x25, 0x50, 0x44, 0x46]) })).toMatchObject({ ok: false, why: expect.stringContaining("10 MB") });
  });

  it("keeps each company's evidence to itself, the case to the Owner, and removes a file that isn't what it says", async () => {
    const t = start();
    const a = await company(t, "owner-a", "Alpha Cleaning");
    const b = await company(t, "owner-b", "Bravo Cleaning");
    await a.as.mutation(api.textingSetup.open, { companyId: a.companyId });
    await b.as.mutation(api.textingSetup.open, { companyId: b.companyId });
    const { evidenceId } = await addFile(t, a.as, a.companyId);
    expect((await workspace(a.as, a.companyId)).evidence.map((row) => [row.purpose, row.state])).toEqual([["opt_in_screenshot", "submitted"]]);
    // Another company can't see, describe or open it, and its own case is empty.
    expect((await workspace(b.as, b.companyId)).evidence).toEqual([]);
    expect(await refusal(b.as.mutation(api.textingCase.describeEvidence, { companyId: b.companyId, evidenceId, describes: "mine" }))).toBe("Not found.");
    expect(await refusal(b.as.query(api.textingCase.fileLink, { companyId: b.companyId, evidenceId }))).toBe("Not found.");
    // A Manager of the same company doesn't see the case: it registers the business.
    const manager = await addMember(t, a.as, a.companyId, "manager-a", "manager");
    expect(await refusal(manager.query(api.textingCase.workspace, { companyId: a.companyId }))).toBe("Not allowed.");
    expect(await refusal(manager.mutation(api.textingCase.addNote, { companyId: a.companyId, body: "hi" }))).toBe("Not allowed.");

    // A file whose bytes don't match its type is removed after upload, and the item asks for a replacement.
    const fake = await upload(t, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "image/png");
    const bad = await a.as.mutation(api.textingCase.addEvidence, { companyId: a.companyId, purpose: "business_document", describes: "Registration", storageId: fake, name: "doc.png" });
    await settle(t);
    const row = (await workspace(a.as, a.companyId)).evidence.find((item) => item.id === bad.evidenceId)!;
    expect(row).toMatchObject({ state: "needs_replacement", kind: "placeholder", file: null });
    expect(await t.run(async (ctx) => (await ctx.storage.get(fake)) === null)).toBe(true);

    // Without signing configured, a file never gets a permanent address.
    expect(await refusal(a.as.query(api.textingCase.fileLink, { companyId: a.companyId, evidenceId }))).toContain("secure links aren't configured");
    process.env.ACTION_LINK_SECRET = "x".repeat(40);
    process.env.CONVEX_SITE_URL = "https://deployment.convex.site.test";
    const link = await a.as.query(api.textingCase.fileLink, { companyId: a.companyId, evidenceId });
    expect(link.url).toMatch(/^https:\/\/deployment\.convex\.site\.test\/texting-evidence\/.+\?exp=\d+&sig=/);
    expect(link.expiresAt - Date.now()).toBeLessThanOrEqual(20 * 60_000);
    // The event log says an item was added and what for: never a file name or an address.
    const events = await t.run((ctx) => ctx.db.query("events").collect());
    expect(JSON.stringify(events.filter((event) => event.type.startsWith("texting.evidence")))).not.toMatch(/booking\.png|texting-evidence\//);
  });

  it("never sends internal notes or staff words to the company, and shows staff the whole case", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await as.mutation(api.textingSetup.open, { companyId });
    const setup = await t.run(async (ctx) => (await ctx.db.query("textingSetups").first())!);
    await as.mutation(api.textingCase.addNote, { companyId, body: "Our form is on the front desk tablet." });
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.textingReview.addNote, { setupId: setup._id, body: "INTERNAL: brand name looks off", internal: true });
    await admin.mutation(api.textingReview.addNote, { setupId: setup._id, body: "Could you add a screenshot of the form?", internal: false });
    await admin.mutation(api.textingReview.exception, { setupId: setup._id, category: "consent_evidence", ownerWords: "Please add a screenshot of your sign-up form.", internalWords: "INTERNAL: suspect pre-checked box", ask: { kind: "evidence", purpose: "opt_in_screenshot" } });
    // An owner can't make an internal note.
    expect(await refusal(as.mutation(api.textingCase.addNote, { companyId, body: "x", internal: true }))).toBe("Not allowed.");

    const owner = await workspace(as, companyId);
    expect(JSON.stringify(owner)).not.toContain("INTERNAL");
    expect(owner.notes.map((note) => note.body)).toEqual(["Our form is on the front desk tablet.", "Could you add a screenshot of the form?"]);
    expect(owner.exceptions[0]).toMatchObject({ ownerWords: "Please add a screenshot of your sign-up form.", internalWords: null, state: "waiting_owner", assignee: "You" });
    // The ask left a placeholder the owner fills in, and the owner answers in the same place.
    expect(owner.evidence.map((row) => [row.purpose, row.state])).toEqual([["opt_in_screenshot", "missing"]]);
    await as.mutation(api.textingCase.respond, { companyId, exceptionId: owner.exceptions[0].id, words: "Added it." });
    const staffView = await admin.query(api.textingReview.caseFor, { setupId: setup._id });
    expect(staffView.notes.map((note) => note.body)).toContain("INTERNAL: brand name looks off");
    expect(staffView.exceptions[0]).toMatchObject({ state: "waiting_selestial", internalWords: "INTERNAL: suspect pre-checked box" });
    // No event carries a note's words, and the company's data export leaves Selestial's internal items out.
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("events").collect()))).not.toContain("INTERNAL");
    for (const table of ["textingNotes", "textingExceptions", "textingEvidence"]) {
      const page = await t.query(internal.dataRights.exportPage, { companyId, table, cursor: null });
      expect(JSON.stringify(page.rows), table).not.toContain("INTERNAL");
    }
    const exported = await t.query(internal.dataRights.exportPage, { companyId, table: "textingNotes", cursor: null });
    expect(exported.rows.map((row) => (row as { body: string }).body)).toEqual(["Our form is on the front desk tablet.", "Could you add a screenshot of the form?"]);
    // Staff without the evidence capability (a reviewer with it removed is not possible; an outsider is not staff at all).
    expect(await refusal(as.query(api.textingReview.caseFor, { setupId: setup._id }))).toBe("Not found.");
  });

  it("keeps the exact evidence versions a submission filed when an item is replaced later", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await prepare(t, as, companyId);
    const first = await addFile(t, as, companyId);
    const { requestId } = await submit(as, companyId);
    const submission = await t.run(async (ctx) => (await ctx.db.query("textingSubmissions").first())!);
    expect(submission.evidence).toEqual([{ evidenceId: first.evidenceId, key: first.key, version: 1 }]);
    const filed = await t.run((ctx) => ctx.db.get(first.evidenceId));
    expect(filed!.lockedIn).toEqual([1]);
    // A filed version can't be re-described or removed.
    expect(await refusal(as.mutation(api.textingCase.describeEvidence, { companyId, evidenceId: first.evidenceId, describes: "changed" }))).toContain("stays as filed");
    expect(await refusal(as.mutation(api.textingCase.removeEvidence, { companyId, evidenceId: first.evidenceId }))).toContain("kept for the record");

    // Selestial asks for a change; the owner replaces the screenshot.
    await t.withIdentity(ADMIN).mutation(api.texting.sendBack, { requestId, words: "Show the unchecked box." });
    const second = await addFile(t, as, companyId, { replaces: first.key, describes: "Form showing the unchecked box" });
    expect(second).toMatchObject({ key: first.key, version: 2 });
    const after = await t.run(async (ctx) => ({ old: await ctx.db.get(first.evidenceId), submission: await ctx.db.get(submission._id) }));
    expect(after.submission!.evidence).toEqual(submission.evidence);
    expect(after.old).toMatchObject({ describes: "Our booking form with the text box", lockedIn: [1], version: 1 });
    expect(after.old!.replacedAt).toBeTypeOf("number");
    expect(await t.run(async (ctx) => (await ctx.storage.get(filed!.file!.storageId)) !== null)).toBe(true);
    const ws = await workspace(as, companyId);
    expect(ws.evidence.map((row) => row.version)).toEqual([2]);
    expect(ws.history.map((row) => [row.version, row.submitted])).toEqual([[1, [1]]]);
    // The correction becomes submission 2, filing version 2; submission 1 still names version 1.
    await submit(as, companyId);
    const all = await t.run((ctx) => ctx.db.query("textingSubmissions").collect());
    expect(all.map((row) => row.evidence!.map((item) => item.version))).toEqual([[1], [2]]);
  });

  it("refuses to apply a suggestion made for older details, and withdraws an approval when the details change", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await as.mutation(api.textingSetup.open, { companyId });
    await as.mutation(api.textingSetup.save, { companyId, revision: await revision(as, companyId), drafts: { sms_consent: BAD_CONSENT } });
    let rec = (await workspace(as, companyId)).recommendations.find((row) => row.key === "draft:sms_consent")!;
    expect(rec).toMatchObject({ status: "open", approval: "owner", responsible: { kind: "check" }, stage: "permission" });
    expect(rec.issue).toContain("text permission wording needs to");
    const old = rec.fingerprint;

    // The owner approves, then changes the wording again: the approval no longer applies.
    await as.mutation(api.textingCase.actOnRecommendation, { companyId, recommendationId: rec.id, fingerprint: old, action: "approve" });
    expect((await workspace(as, companyId)).recommendations.find((row) => row.id === rec.id)!.status).toBe("approved");
    await as.mutation(api.textingSetup.save, { companyId, revision: await revision(as, companyId), drafts: { sms_consent: `${BAD_CONSENT} Thanks!` } });
    rec = (await workspace(as, companyId)).recommendations.find((row) => row.id === rec.id)!;
    expect(rec.status).toBe("stale");
    expect(rec.fingerprint).not.toBe(old);
    expect(await t.run(async (ctx) => (await ctx.db.get(rec.id))!.approvedAt === undefined)).toBe(true);

    // Applying with the old fingerprint changes nothing: the newer words stay.
    expect(await refusal(as.mutation(api.textingCase.actOnRecommendation, { companyId, recommendationId: rec.id, fingerprint: old, action: "apply" }))).toContain("earlier version");
    expect((await as.query(api.textingSetup.view, { companyId }))!.setup.drafts.sms_consent.text).toBe(`${BAD_CONSENT} Thanks!`);
    // With the current one it applies Selestial's wording, and the finding is resolved.
    await as.mutation(api.textingCase.actOnRecommendation, { companyId, recommendationId: rec.id, fingerprint: rec.fingerprint, action: "apply" });
    const view = (await as.query(api.textingSetup.view, { companyId }))!;
    expect(view.drafts.find((row) => row.key === "sms_consent")!.gaps).toEqual([]);
    // It stays listed as applied, so the owner can see what was changed and by which suggestion.
    expect((await workspace(as, companyId)).recommendations.find((row) => row.key === "draft:sms_consent")!.status).toBe("applied");
  });

  it("asks before a name differs, never picks one, and proposes a redacted copy of an opt-in screenshot", () => {
    const base = { companyName: "Alpha Cleaning LLC", setup: { business: { displayName: "Sparkle Maids" }, sources: [{ field: "displayName", source: "website", confirmed: false }], activities: ["promotions"], places: ["website"], hosting: "selestial", drafts: {} }, draftInput: { name: "Sparkle Maids", activities: ["promotions"], marketingPerWeek: 1, links: { privacy: "p", terms: "t", signup: "s" }, places: ["website"] }, request: null, evidence: [], config: parseConfig("{}").config! };
    const found = findings(base);
    const name = found.find((row) => row.rule === "name_mismatch")!;
    expect(name).toMatchObject({ proposal: { kind: "confirm_field", field: "displayName" }, approval: "owner" });
    expect(name.effect).toContain("never picks a name");
    // The same name with a legal suffix is not a difference.
    expect(findings({ ...base, setup: { ...base.setup, business: { displayName: "Alpha Cleaning" } } }).some((row) => row.rule === "name_mismatch")).toBe(false);
    // Promotions without marketing permission wording: Retention, which owns promotions, is responsible.
    const promo = found.find((row) => row.rule === "promotions_without_marketing_consent")!;
    expect(promo).toMatchObject({ responsible: { kind: "agent", agent: "retention" }, proposal: { kind: "draft_text", draftKey: "marketing_consent" } });
    const copy = findings({ ...base, evidence: [{ id: "e1", key: "k1", purpose: "opt_in_screenshot", kind: "file", visibility: "company", state: "submitted", replaced: false }] }).find((row) => row.rule === "review_copy")!;
    expect(copy.proposal).toEqual({ kind: "review_copy", evidenceId: "e1" });
    // An active registration that doesn't cover promotions says so, and approving it charges nothing.
    const gap = findings({ ...base, request: { status: "active", activities: ["job_offers"] } }).find((row) => row.rule === "coverage_gap")!;
    expect(gap.issue).toContain("but not promotions");
    expect(gap.approval).toBe("owner_and_charges");
    expect(gap.effect).toContain("doesn't file or charge anything");
  });

  it("shows a review copy publicly only after the owner approves it in exact words and Selestial accepts it", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await as.mutation(api.textingSetup.open, { companyId });
    const original = await addFile(t, as, companyId);
    const storageId = await upload(t, PNG, "image/png");
    const copy = await as.mutation(api.textingCase.addEvidence, { companyId, purpose: "opt_in_screenshot", describes: "Blank copy", storageId, name: "blank.png", reviewCopyOf: original.evidenceId });
    await settle(t);
    expect(await refusal(as.mutation(api.textingCase.setReviewExposure, { companyId, evidenceId: copy.evidenceId, approve: true, wording: REVIEW_COPY_WORDING }))).toContain("hasn't been accepted");
    await t.withIdentity(ADMIN).mutation(api.textingReview.reviewEvidence, { evidenceId: copy.evidenceId, state: "accepted_internal" });
    expect(await refusal(as.mutation(api.textingCase.setReviewExposure, { companyId, evidenceId: copy.evidenceId, approve: true, wording: "ok" }))).toContain("accept the statement");
    // Only a copy can be exposed, never the original.
    expect(await refusal(as.mutation(api.textingCase.setReviewExposure, { companyId, evidenceId: original.evidenceId, approve: true, wording: REVIEW_COPY_WORDING }))).toContain("Only the current review copy");
    await as.mutation(api.textingCase.setReviewExposure, { companyId, evidenceId: copy.evidenceId, approve: true, wording: REVIEW_COPY_WORDING });
    const token = (await t.run((ctx) => ctx.db.get(copy.evidenceId)))!.reviewCopy!.token!;
    expect(await t.query(api.textingCase.workspace, { companyId }).catch(() => "refused")).toBe("refused");
    const served = await t.fetch(`/texting-review/${token}`, { method: "GET" });
    expect(served.status).toBe(200);
    // Withdrawn: a plain 404, like any wrong address.
    await as.mutation(api.textingCase.setReviewExposure, { companyId, evidenceId: copy.evidenceId, approve: false });
    expect((await t.fetch(`/texting-review/${token}`, { method: "GET" })).status).toBe(404);
  });

  it("validates configuration strictly, needs a second admin for requirements, reopens only unfinished setups, and rolls back", async () => {
    // Only approved shapes: no code, no patterns, no loosening a limit.
    expect(parseConfig(JSON.stringify({ rules: [{ type: "regex", field: "website", pattern: ".*" }] })).problems[0]).toContain("isn't an approved rule type");
    expect(parseConfig(JSON.stringify({ rules: [{ type: "max_length", field: "displayName", max: 500 }] })).problems[0]).toContain("never loosen");
    expect(parseConfig(JSON.stringify({ ownership: [{ task: "permission", owner: "texting_bot" }] })).problems[0]).toContain("New agents can't be made here");
    expect(parseConfig(JSON.stringify({ templates: [{ key: "recommendation.name_mismatch", words: "<script>{a}</script>" }] })).problems[0]).toContain("plain text");
    expect(parseConfig(JSON.stringify({ prerequisites: [{ step: "business", requires: ["number"] }, { step: "number", requires: ["business"] }] })).problems).toContain("The prerequisites go round in a circle, so no step could ever be started.");
    expect(parseConfig(JSON.stringify({ fields: [{ field: "displayName", label: "Brand name" }] }))).toMatchObject({ problems: [], needsReview: false });

    const t = start();
    const unfinished = await company(t, "owner-a", "Alpha Cleaning");
    const submitted = await company(t, "owner-b", "Bravo Cleaning");
    await prepare(t, submitted.as, submitted.companyId);
    await submit(submitted.as, submitted.companyId);
    await prepare(t, unfinished.as, unfinished.companyId);
    const admin = t.withIdentity(ADMIN);
    const draftId = await admin.mutation(api.textingConfig.createDraft, { reason: "Carriers now reject P.O. boxes in brand addresses" });
    // The second admin is added once the first exists (the bootstrap address only works while there is none).
    await staffWith(t, SECOND_ADMIN, []);
    const second = t.withIdentity(SECOND_ADMIN);
    const body = JSON.stringify({ rules: [{ type: "pattern_preset", field: "street", preset: "no_po_box" }], providerRequirements: [{ key: "address", words: "Brand address must be a physical address.", sourceUrl: "https://support.telnyx.com/example", verifiedOn: "2026-11-22" }] });
    await admin.mutation(api.textingConfig.editDraft, { versionId: draftId, body });
    expect(await refusal(admin.mutation(api.textingConfig.publish, { versionId: draftId }))).toContain("Validate");
    expect(await admin.mutation(api.textingConfig.validate, { versionId: draftId })).toEqual({ ok: true, problems: [] });
    // Make the unfinished setup affected, then preview it.
    await unfinished.as.mutation(api.textingSetup.save, { companyId: unfinished.companyId, revision: await revision(unfinished.as, unfinished.companyId), business: { street: "PO Box 12" } });
    const preview = await admin.query(api.textingConfig.preview, { versionId: draftId });
    expect(preview).toMatchObject({ ok: true, needsReview: true, affectedCount: 1 });
    expect(await refusal(admin.mutation(api.textingConfig.publish, { versionId: draftId }))).toContain("another admin must review");
    expect(await second.mutation(api.textingConfig.publish, { versionId: draftId })).toEqual({ affected: 1 });

    const reopened = (await unfinished.as.query(api.textingSetup.view, { companyId: unfinished.companyId }))!;
    expect(reopened.config.version).toBe(1);
    expect(reopened.config.reopened.map((row) => row.step)).toEqual(["business"]);
    expect(reopened.issues.business.map((row) => row.words)).toContain("street can't be a P.O. box.");
    expect(reopened.setup.notes.some((note) => note.words.includes("reopened Your business"))).toBe(true);
    // The submitted company keeps the configuration it was submitted under.
    const filed = await t.run(async (ctx) => (await ctx.db.query("textingSubmissions").collect()).find((row) => row.companyId === submitted.companyId)!);
    expect(filed.configVersion).toBe(0);
    expect((await submitted.as.query(api.textingSetup.view, { companyId: submitted.companyId }))!.config.reopened).toEqual([]);

    // Retiring puts the built-in configuration back; a rollback copies an earlier version into a new one.
    expect(await admin.mutation(api.textingConfig.retire, { versionId: draftId })).toEqual({ active: 0 });
    expect((await unfinished.as.query(api.textingSetup.view, { companyId: unfinished.companyId }))!.issues.business.map((row) => row.words)).not.toContain("street can't be a P.O. box.");
    const rollbackId = await admin.mutation(api.textingConfig.rollback, { toVersion: 1, reason: "The carriers' rule is still in force" });
    await second.mutation(api.textingConfig.publish, { versionId: rollbackId });
    const versions = (await admin.query(api.textingConfig.list, {})).versions;
    expect(versions.map((row) => [row.version, row.status, row.basedOn])).toEqual([[2, "published", 1], [1, "retired", null]]);
    // Only admins change it.
    expect(await refusal(unfinished.as.mutation(api.textingConfig.createDraft, { reason: "I want to change the rules" }))).toBe("Not found.");
  });

  it("ends support access to evidence, notes and exceptions when the session expires or the owner revokes Manage", async () => {
    const t = start();
    const { as: owner, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await owner.mutation(api.textingSetup.open, { companyId });
    const { evidenceId } = await addFile(t, owner, companyId);
    const { staff, sessionId } = await manageSession(t, owner, companyId);
    const inSession = { companyId, supportSessionId: sessionId };

    // In the session staff see the internal side, but a file opens only with content revealed.
    expect((await staff.query(api.textingCase.workspace, inSession))!.viewer).toMatchObject({ kind: "support", staff: true, revealed: false });
    expect(await refusal(staff.query(api.textingCase.fileLink, { ...inSession, evidenceId }))).toContain("Reveal content");
    await staff.mutation(api.textingCase.addNote, { ...inSession, body: "INTERNAL session note", internal: true });
    await staff.mutation(api.textingCase.manageException, { ...inSession, category: "business_details", ownerWords: "Please confirm your legal name matches your IRS letter.", ask: { kind: "correction", field: "legalName" } });
    // Owner-only decisions stay closed, even in Manage.
    expect(await refusal(staff.mutation(api.textingCase.setReviewExposure, { ...inSession, evidenceId, approve: true, wording: REVIEW_COPY_WORDING }))).toContain("can't do this");
    expect(await refusal(staff.mutation(api.textingCase.setNumberRoute, { ...inSession, revision: 1, route: "toll_free" }))).toContain("can't do this");
    expect(JSON.stringify(await workspace(owner, companyId))).not.toContain("INTERNAL");
    const history = await owner.query(api.support.history, { companyId });
    expect(JSON.stringify(history)).toContain("added a note to your texting setup");

    // The owner ends Manage: nothing more can be written.
    await owner.mutation(api.support.revokeManage, { companyId });
    expect(await refusal(staff.mutation(api.textingCase.addNote, { ...inSession, body: "after revoke" }))).toMatch(/Manage access has ended|view only/);
    // The session expires: nothing more can be read either.
    await t.run((ctx) => ctx.db.patch(sessionId, { expiresAt: Date.now() - 1 }));
    expect(await refusal(staff.query(api.textingCase.workspace, inSession))).toContain("has ended");
    expect(await refusal(staff.mutation(api.textingCase.addEvidence, { ...inSession, purpose: "other", describes: "x", url: "https://example.com" }))).toContain("has ended");
  });

  it("keeps local, existing-number and toll-free journeys apart, and never files a toll-free number as local", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const searchId = await prepare(t, as, companyId);
    await as.mutation(api.textingCase.setNumberRoute, { companyId, revision: await revision(as, companyId), route: "toll_free" });
    let view = (await as.query(api.textingSetup.view, { companyId }))!;
    expect(view.route).toBe("toll_free");
    expect(view.issues.number[0]).toContain("toll-free verification");
    expect(await refusal(as.mutation(api.textingSetup.chooseNumber, { companyId, revision: view.setup.revision, searchId, phoneNumber: "+15125550142" }))).toContain("Switch to a new local number");
    expect(await refusal(submit(as, companyId))).toContain("separate request");
    const assisted = await as.mutation(api.textingCase.requestAssistance, { companyId, route: "toll_free", words: "We'd like an 888 number." });
    const ws = await workspace(as, companyId);
    expect(ws.exceptions.find((row) => row.id === assisted)).toMatchObject({ category: "toll_free", state: "waiting_selestial", assignee: "Selestial", assisted: { route: "toll_free" } });
    expect(ws.exceptions[0].canContinue).toContain("keeps working");
    expect(await refusal(as.mutation(api.textingCase.requestAssistance, { companyId, route: "toll_free" }))).toContain("already has this request");

    // Bringing a number needs the continuity statement accepted, and a real US number.
    await as.mutation(api.textingCase.setNumberRoute, { companyId, revision: await revision(as, companyId), route: "port_existing" });
    expect(await refusal(as.mutation(api.textingCase.requestAssistance, { companyId, route: "port_existing", phoneNumber: "512 555 0199" }))).toContain("Read and accept");
    expect(await refusal(as.mutation(api.textingCase.requestAssistance, { companyId, route: "port_existing", phoneNumber: "555", acknowledgement: PORT_WORDING }))).toContain("US number");
    await as.mutation(api.textingCase.requestAssistance, { companyId, route: "port_existing", phoneNumber: "512 555 0199", acknowledgement: PORT_WORDING });
    expect((await workspace(as, companyId)).exceptions.find((row) => row.category === "number_port")!.assisted).toMatchObject({ phoneNumber: "+15125550199" });

    // Back to a new local number: the guided registration is exactly as it was, with the chosen number kept.
    await as.mutation(api.textingCase.setNumberRoute, { companyId, revision: await revision(as, companyId), route: "new_local" });
    view = (await as.query(api.textingSetup.view, { companyId }))!;
    expect(view.issues.number).toEqual([]);
    const { requestId } = await submit(as, companyId);
    expect(requestId).toBeTruthy();
    // Once a local registration is with Selestial, the journey can't be switched underneath it.
    expect(await refusal(as.mutation(api.textingCase.setNumberRoute, { companyId, revision: await revision(as, companyId), route: "toll_free" }))).toContain("already with Selestial");
  });

  it("publishes a written guide only under its own criteria, without video, and keeps each person's place", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const admin = t.withIdentity(ADMIN);
    // Nothing is published by default: the GoHighLevel guide is ready for review, not shown to owners.
    expect((await as.query(api.tutorials.published, { companyId })).map((row) => row.id)).not.toContain("ghl-export-contacts");
    expect(await refusal(admin.mutation(api.tutorials.setState, { tutorialId: "ghl-export-contacts", state: "published" }))).toContain("written-guide criteria");
    expect(await refusal(admin.mutation(api.tutorials.confirmWrittenReview, { tutorialId: "ghl-export-contacts", confirmed: WRITTEN_CRITERIA.slice(0, 2) as unknown as string[] }))).toContain("Confirm every criterion");
    vi.setSystemTime(new Date("2026-11-23T12:00:00Z"));
    await admin.mutation(api.tutorials.confirmWrittenReview, { tutorialId: "ghl-export-contacts", confirmed: [...WRITTEN_CRITERIA] });
    // A video can't ride on a written guide.
    await admin.mutation(api.tutorials.setMedia, { tutorialId: "ghl-export-contacts", media: { version: 1, video: "/v.mp4", poster: "/p.jpg", captions: "/c.vtt", durationSeconds: 60 } });
    expect(await refusal(admin.mutation(api.tutorials.setState, { tutorialId: "ghl-export-contacts", state: "published" }))).toContain("can't carry a video");
    await admin.mutation(api.tutorials.setMedia, { tutorialId: "ghl-export-contacts", media: null });
    await admin.mutation(api.tutorials.setState, { tutorialId: "ghl-export-contacts", state: "published" });
    const shown = (await as.query(api.tutorials.published, { companyId })).find((row) => row.id === "ghl-export-contacts")!;
    expect(shown).toMatchObject({ guide: "written", media: null, interfaceVerifiedOn: null });
    expect(shown.mapping!.length).toBeGreaterThan(0);
    expect(shown.limitations.join(" ")).toContain("Not yet followed in a real HighLevel account");
    // A written guide whose sources are old can't be published.
    vi.setSystemTime(new Date("2027-06-01T12:00:00Z"));
    await admin.mutation(api.tutorials.setState, { tutorialId: "ghl-export-contacts", state: "ready_for_review" });
    expect(await refusal(admin.mutation(api.tutorials.setState, { tutorialId: "ghl-export-contacts", state: "published" }))).toContain("more than 120 days ago");

    // Progress: tick steps, resume later; a step outside the guide is refused.
    await as.mutation(api.tutorials.markStep, { companyId, tutorialId: "ghl-export-contacts", step: 0, done: true });
    await as.mutation(api.tutorials.markStep, { companyId, tutorialId: "ghl-export-contacts", step: 1, done: true });
    await as.mutation(api.tutorials.markStep, { companyId, tutorialId: "ghl-export-contacts", step: 0, done: false });
    expect(await as.query(api.tutorials.progress, { companyId })).toEqual([{ tutorialId: "ghl-export-contacts", done: [1], completedAt: null }]);
    expect(await refusal(as.mutation(api.tutorials.markStep, { companyId, tutorialId: "ghl-export-contacts", step: 99, done: true }))).toContain("isn't in this tutorial");
  });

  it("imports never record consent and never lift an existing opt-out", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await t.run((ctx) => ctx.db.insert("suppressions", { companyId, channel: "sms", address: "+15125550101", scope: "all", reason: "stop_keyword", at: Date.now() }));
    const before = await t.run((ctx) => ctx.db.query("suppressions").collect());
    const done = await as.mutation(api.clientImports.commit, { companyId, importKey: "ghl-1", source: "csv", label: "GoHighLevel export", rows: [{ index: 0, row: { name: "Dana Whitfield", phone: "512-555-0101", email: "dana@example.com" } }, { index: 1, row: { name: "Rosa Diaz", phone: "512-555-0102" } }], addAnyway: [], skip: [] });
    expect(done.created).toBe(2);
    const after = await t.run(async (ctx) => ({ suppressions: await ctx.db.query("suppressions").collect(), permissions: await ctx.db.query("contactPermissions").collect(), customers: await ctx.db.query("customers").collect() }));
    expect(after.suppressions).toEqual(before);
    expect(after.permissions).toEqual([]);
    // Consent stays unknown: no communication permission is set on any imported client.
    expect(after.customers.every((row) => row.communication === undefined)).toBe(true);
  });
});
