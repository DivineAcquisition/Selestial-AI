/**
 * @vitest-environment edge-runtime
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { refusal } from "../tests/harness";
import { ANSWERS, emailsTo, flush, indeedApplication, invited, recruiterTestEnv, setup, tokenFor, type Setup } from "../tests/recruiterHarness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { defaultSettings } from "./lib/booking/settings";
import { COLUMNS, moveFor } from "./lib/recruiter/board";
import { fieldsFor, missingRequired, visibleFields } from "./lib/recruiter/form";
import { normalizeForm, OVER_18_WORDING, type FormDefinition } from "./lib/recruiter/formDefinition";
import { classicForm, FORM_TEMPLATES, standardCleanerForm } from "./lib/recruiter/formTemplates";
import { mockEmails } from "./lib/messaging/email";

const MARIA = "maria.lopez@example.test";
const SECRET = "test-public-form-secret";

/** Every answer the full cleaner application needs for the test role. */
const FULL = {
  fullName: "Maria Lopez",
  email: MARIA,
  phone: "5125550142",
  address: ["12 Oak St", "Austin", "TX", "78701"],
  "f.own_car": true,
  "f.license": true,
  "f.auto_insurance": true,
  "f.work_as": "Just me",
  over18: true,
  workAuthorized: true,
  experienceYears: 3,
  "f.availability": "Full-time",
  availableDays: ["Tuesday", "Saturday"],
  hoursPerWeek: 25,
  serviceAreas: ["78701"],
  "f.contractor_terms": true,
  "f.background_check": true,
  "f.pay_terms": true,
  "f.supplies_willing": true,
  "f.reliability": "I plan my route the night before.",
  "f.why_us": "I like working with a small team.",
  "q.own_supplies": true,
};

const withField = (def: FormDefinition, field: Partial<FormDefinition["sections"][number]["fields"][number]>) => {
  const copy = structuredClone(def);
  copy.sections[0].fields.push({ id: "extra", builtin: false, kind: "text", label: "x", help: "", placeholder: "", required: false, options: [], ...field });
  return copy;
};

async function starter(s: Setup) {
  const { formId } = await s.as.mutation(api.applicationForms.ensureStarter, { companyId: s.companyId });
  return formId as Id<"applicationForms">;
}

async function publicPage(s: Setup, handle = "alpha") {
  await s.t.run(async (ctx) => {
    const company = (await ctx.db.get(s.companyId))!;
    await ctx.db.insert("bookingSettings", { ...defaultSettings(company), handle });
  });
}

describe("Recruiter: application forms", () => {
  let undo = () => {};
  beforeEach(() => {
    undo = recruiterTestEnv();
    process.env.PUBLIC_FORM_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.PUBLIC_FORM_SECRET;
    undo();
  });

  it("starts every template checked, and refuses what an application never asks", () => {
    for (const template of FORM_TEMPLATES) expect(() => normalizeForm(template.make()), template.key).not.toThrow();
    const base = classicForm();
    expect(() => normalizeForm(withField(base, { label: "Upload a photo of your government-issued ID" }))).toThrow(/identity document/);
    expect(() => normalizeForm(withField(base, { label: "Your Social Security number" }))).toThrow(/tax identifier/);
    expect(() => normalizeForm(withField(base, { label: "Bank account for direct deposit" }))).toThrow(/bank or card/);
    // Free wording still passes the fairness guard; the eligibility questions exist only as fixed standard fields.
    expect(() => normalizeForm(withField(base, { label: "How old are you?" }))).toThrow(/age/);
    expect(() => normalizeForm(withField(base, { label: "Are you a US citizen?" }))).toThrow(/citizenship/);
    const over18 = structuredClone(base);
    over18.sections[0].fields.push({ id: "over18", builtin: true, kind: "yes_no", label: "Anything else", help: "", placeholder: "", required: true, options: [] });
    expect(normalizeForm(over18).sections[0].fields.at(-1)!.label).toBe(OVER_18_WORDING);
    // The name and email are always asked, and always required.
    const noEmail = structuredClone(base);
    noEmail.sections[0].fields = noEmail.sections[0].fields.filter((field) => field.id !== "email");
    expect(() => normalizeForm(noEmail)).toThrow(/email address/);
    const optional = structuredClone(base);
    optional.sections[0].fields[0].required = false;
    expect(normalizeForm(optional).sections[0].fields[0].required).toBe(true);
    expect(() => normalizeForm({ ...base, invitation: { subject: "Apply", body: "No link here" } })).toThrow(/\{link\}/);
  });

  it("asks a conditional question only after the answer it depends on, and only requires what is shown", () => {
    const need = { coverageAreas: ["78701"], questions: [] };
    const fields = fieldsFor(normalizeForm(standardCleanerForm()), need, "Alpha Cleaning");
    const keys = (answers: Record<string, string | number | boolean | string[]>) => visibleFields(fields, answers).map((field) => field.key);
    expect(keys({})).not.toContain("f.license");
    expect(keys({ "f.own_car": true })).toContain("f.license");
    expect(keys({ "f.own_car": false })).not.toContain("f.license");
    expect(missingRequired(fields, { "f.own_car": false }).map((field) => field.key)).not.toContain("f.license");
    expect(missingRequired(fields, { "f.own_car": true }).map((field) => field.key)).toContain("f.license");
    // An unticked required agreement is not an answer.
    expect(missingRequired(fields, { "f.contractor_terms": false }).map((field) => field.key)).toContain("f.contractor_terms");
  });

  it("sets up the full application for the Owner, and keeps each applicant on the version they started", async () => {
    const s = await setup();
    const formId = await starter(s);
    expect(await starter(s)).toBe(formId);
    const overview = await s.as.query(api.applicationForms.overview, { companyId: s.companyId });
    expect(overview.forms).toMatchObject([{ name: "Cleaner application", isDefault: true, publishedVersion: 1 }]);
    expect(overview.roles).toMatchObject([{ title: "House Cleaner", formId: null, formName: "Cleaner application", publicApply: false }]);

    const { token, applicationId } = await invited(s);
    const page = await s.t.query(api.applicantPages.application, { token });
    expect(page.look.display).toBe("one_at_a_time");
    expect(page.form!.fields.map((field) => field.key)).toContain("f.own_car");
    expect(page.form!.sections.at(-1)).toMatchObject({ id: "role", title: "About the House Cleaner role" });
    await s.t.mutation(api.applicantPages.saveDraft, { token, answers: { phone: "5125550142" } });

    // The Owner removes a question and publishes. Maria keeps hers; a new applicant gets the new version.
    const form = await s.as.query(api.applicationForms.get, { companyId: s.companyId, formId });
    const draft = structuredClone(form.draft) as FormDefinition;
    draft.sections = draft.sections.filter((section) => section.id !== "supplies");
    const saved = await s.as.mutation(api.applicationForms.saveDraft, { companyId: s.companyId, formId, expectedRevision: form.form.draftRevision, definition: draft });
    expect(saved).toMatchObject({ ok: true });
    expect(await s.as.mutation(api.applicationForms.saveDraft, { companyId: s.companyId, formId, expectedRevision: form.form.draftRevision, definition: draft })).toMatchObject({ ok: false, conflict: { revision: 2 } });
    await s.as.mutation(api.applicationForms.publish, { companyId: s.companyId, formId, expectedRevision: 2 });
    const mine = await s.t.query(api.applicantPages.application, { token });
    expect(mine.form!.fields.map((field) => field.key)).toContain("f.supplies_willing");

    await s.t.mutation(api.applicantPages.submit, { token, answers: FULL, attested: true });
    await flush(s.t);
    const detail = await s.detail(applicationId);
    expect(detail.stage).toBe("screening");
    expect(detail.form!.answers.find((row) => row.key === "address")).toMatchObject({ answer: "12 Oak St, Austin, TX, 78701" });
    expect(detail.form!.answers.find((row) => row.key === "f.contractor_terms")).toMatchObject({ answer: "Agreed" });
  });

  it("turns a knockout answer into a requirement screening shows, after telling nobody but a person", async () => {
    const s = await setup();
    await starter(s);
    const { token, applicationId } = await invited(s);
    await s.t.mutation(api.applicantPages.submit, { token, answers: { ...FULL, over18: false, workAuthorized: false }, attested: true });
    await flush(s.t);
    const { screening, stage } = await s.detail(applicationId);
    expect(stage).toBe("screening");
    const rows = Object.fromEntries(screening!.results.map((row) => [row.key, row]));
    expect(rows.form_over18).toMatchObject({ outcome: "does_not_meet", fixed: true });
    expect(rows.form_workAuthorized).toMatchObject({ outcome: "does_not_meet", fixed: false });
    expect(rows.form_f_own_car).toMatchObject({ outcome: "meets" });
    expect(screening!.recommendation).toBe("review_requirement");
  });

  it("sends the invitation in the form's own words, with Recruiter's footer", async () => {
    const s = await setup();
    const formId = await starter(s);
    const form = await s.as.query(api.applicationForms.get, { companyId: s.companyId, formId });
    const draft = { ...(form.draft as FormDefinition), invitation: { subject: "{company} would love your application", body: "Hi {first_name},\n\nApply for {role} here: {link}" } };
    await s.as.mutation(api.applicationForms.saveDraft, { companyId: s.companyId, formId, expectedRevision: form.form.draftRevision, definition: draft });
    await s.as.mutation(api.applicationForms.publish, { companyId: s.companyId, formId, expectedRevision: form.form.draftRevision + 1 });
    await invited(s);
    const [email] = emailsTo(MARIA);
    expect(email.subject).toBe("Alpha Cleaning would love your application");
    expect(email.text).toContain("Hi Maria,");
    expect(email.text).toMatch(/Apply for House Cleaner here: \S+\/c\/apply\//);
    expect(email.text).toContain("an automated system");
  });

  it("sends the application to a list of people, each with their own link, and skips who is already applying", async () => {
    const s = await setup();
    const results = await s.as.mutation(api.applications.sendApplication, { companyId: s.companyId, needId: s.needId, recipients: [{ email: "Jo.Park@example.test", name: "Jo Park" }, { email: "sam@example.test" }, { email: "jo.park@example.test" }, { email: "not-an-email" }] });
    await flush(s.t);
    expect(results.map((row) => [row.email, row.outcome])).toEqual([["jo.park@example.test", "sent"], ["sam@example.test", "sent"], ["not-an-email", "skipped"]]);
    expect(emailsTo("jo.park@example.test")[0].text).toContain("Hi Jo,");
    expect(emailsTo("sam@example.test")[0].text).toContain("Hello,");
    expect(tokenFor("sam@example.test", "apply")).not.toBe(tokenFor("jo.park@example.test", "apply"));
    const again = await s.as.mutation(api.applications.sendApplication, { companyId: s.companyId, needId: s.needId, recipients: [{ email: "sam@example.test" }] });
    expect(again).toMatchObject([{ outcome: "skipped", detail: "This person already has an open application for that role." }]);
    const office = await s.office();
    expect(await refusal(office.mutation(api.applications.sendApplication, { companyId: s.companyId, needId: s.needId, recipients: [{ email: "x@example.test" }] }))).toBeTruthy();
  });

  it("lets anyone start on the public page, hands them their own link, and never opens someone else's", async () => {
    const s = await setup();
    await starter(s);
    await publicPage(s);
    const start = (fields: Partial<{ name: string; email: string; website: string; visitorKey: string }> = {}) => s.t.mutation(api.applyPublic.start, { secret: SECRET, handle: "alpha", slug: "house-cleaner", name: "Lee Chen", email: "lee@example.test", website: "", visitorKey: "v1", ...fields });

    // Off until the Owner turns it on.
    expect(await s.t.query(api.applyPublic.careers, { handle: "alpha" })).toMatchObject({ company: { name: "Alpha Cleaning" }, roles: [] });
    expect(await refusal(start())).toContain("isn't taking applications");
    const { slug } = await s.as.mutation(api.hiringNeeds.setPublicApply, { companyId: s.companyId, needId: s.needId, publicApply: true });
    expect(slug).toBe("house-cleaner");
    expect((await s.t.query(api.applyPublic.careers, { handle: "alpha" }))!.roles).toMatchObject([{ slug: "house-cleaner", title: "House Cleaner" }]);
    expect((await s.t.query(api.applyPublic.role, { handle: "alpha", slug }))!.look).toMatchObject({ display: "one_at_a_time", copy: { title: "Apply for House Cleaner at Alpha Cleaning" } });
    expect(await refusal(s.t.mutation(api.applyPublic.start, { secret: "wrong", handle: "alpha", slug, name: "x", email: "x@example.test", website: "", visitorKey: "v" }))).toBe("Not found.");

    // A script that fills every field makes nothing.
    expect(await start({ website: "https://spam.example" })).toHaveProperty("checkEmail");
    expect(await s.applications()).toHaveLength(0);

    const started = (await start()) as { token: string };
    expect(started.token).toMatch(/\./);
    const page = await s.t.query(api.applicantPages.application, { token: started.token });
    expect(page).toMatchObject({ state: "open", form: { answers: { fullName: "Lee Chen", email: "lee@example.test" } } });
    const [row] = await s.applications();
    expect(row).toMatchObject({ source: "website", stage: "application_started", name: "Lee Chen" });

    // The same address again: no link here, and the link to continue goes to that address.
    mockEmails.length = 0;
    expect(await start({ name: "Someone Else" })).toHaveProperty("checkEmail");
    await flush(s.t);
    expect(emailsTo("lee@example.test")).toHaveLength(1);
    expect(emailsTo("lee@example.test")[0].subject).toBe("Continue your House Cleaner application at Alpha Cleaning");
    expect(await s.applications()).toHaveLength(1);

    // A few starts an hour from one place.
    for (let i = 0; i < 8; i += 1) expect(await start({ email: `p${i}@example.test`, visitorKey: "v2" })).toHaveProperty("token");
    expect(await start({ email: "p9@example.test", visitorKey: "v2" })).toHaveProperty("refused");
  });

  it("moves cards on the board only where the matching button could, and does what it says", async () => {
    expect(moveFor("received", "invite")).toMatchObject({ move: "invite" });
    expect(moveFor("received", "interview")).toBeNull();
    expect(moveFor("application_started", "screen")).toBeNull();
    expect(moveFor("screening", "decide")).toMatchObject({ move: "hold", needs: "reason" });
    expect(moveFor("accepted", "closed")).toBeNull();
    expect(COLUMNS.flatMap((column) => column.stages)).toHaveLength(14);

    const s = await setup();
    const applicationId = await s.as.mutation(api.applications.addManually, { companyId: s.companyId, needId: s.needId, name: "Ana Ruiz", email: "ana@example.test" });
    expect(await refusal(s.as.mutation(api.applications.move, { companyId: s.companyId, applicationId, to: "interview" }))).toContain("can't be moved there");
    await s.as.mutation(api.applications.move, { companyId: s.companyId, applicationId, to: "invite" });
    await flush(s.t);
    expect(emailsTo("ana@example.test")).toHaveLength(1);
    expect((await s.detail(applicationId)).stage).toBe("invited");

    const token = tokenFor("ana@example.test", "apply");
    await s.t.mutation(api.applicantPages.submit, { token, answers: { ...ANSWERS, fullName: "Ana Ruiz", email: "ana@example.test" }, attested: true });
    await flush(s.t);
    expect(await refusal(s.as.mutation(api.applications.move, { companyId: s.companyId, applicationId, to: "decide" }))).toContain("reason");
    await s.as.mutation(api.applications.move, { companyId: s.companyId, applicationId, to: "decide", reason: "Waiting on a reference." });
    expect((await s.detail(applicationId)).stage).toBe("decision_pending");
    mockEmails.length = 0;
    await s.as.mutation(api.applications.move, { companyId: s.companyId, applicationId, to: "closed", closure: "not_selected", tellApplicant: true });
    await flush(s.t);
    expect((await s.detail(applicationId))).toMatchObject({ stage: "closed", closure: { reason: "not_selected" } });
    expect(emailsTo("ana@example.test")).toHaveLength(1);
  });

  it("keeps the original short form for a company that never built one", async () => {
    const s = await setup();
    const { token } = await invited(s, indeedApplication());
    const page = await s.t.query(api.applicantPages.application, { token });
    expect(page.look.display).toBe("sections");
    expect(page.form!.fields.map((field) => field.key)).toEqual(["fullName", "email", "phone", "smsConsent", "city", "experienceYears", "experienceSummary", "availableDays", "hoursPerWeek", "earliestStart", "serviceAreas", "q.own_supplies"]);
  });
});
