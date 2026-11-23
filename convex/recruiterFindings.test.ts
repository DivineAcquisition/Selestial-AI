/**
 * @vitest-environment edge-runtime
 *
 * Findings and direct sends (convex/lib/recruiter/findings.ts, act.ts): what Recruiter prepares for each
 * application, that a person's Send is the authorization (no second approval), that every check still runs,
 * and that a prepared message whose facts changed can never be sent.
 *
 * INVENTED FIXTURES: every Indeed message here is made up (docs/recruiter/07-real-samples.md).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { company, refusal } from "../tests/harness";
import { DAY, emailsTo, flush, HOUR, indeedApplication, invited, later, mail, MONDAY_10AM, recruiterTestEnv, setup, type Setup } from "../tests/recruiterHarness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mockEmails } from "./lib/messaging/email";

const MARIA = "maria.lopez@example.test";
const ANA = "ana.ruiz@example.test";
const WEDNESDAY_2PM = MONDAY_10AM + 2 * DAY + 4 * HOUR;

const send = (s: Setup, findingId: Id<"recruiterFindings">, edit?: { subject: string; body: string }) => s.as.mutation(api.recruiterFindings.send, { companyId: s.companyId, findingId, edit });
const inquiry = () => mail({ from: `Ana Ruiz <${ANA}>`, subject: "Are you hiring cleaners?", text: "Hi, are you hiring? I have cleaned homes for two years.\nAna" });
const ownerId = async (s: Setup) => (await s.as.query(api.members.list, { companyId: s.companyId }))[0].id as Id<"members">;

describe("Recruiter's findings", () => {
  let undo: () => void;
  beforeEach(() => {
    undo = recruiterTestEnv();
  });
  afterEach(() => undo());

  it("a new application: explained from what was reported, never as verified, with the link ready to send", async () => {
    const s = await setup();
    await s.receive(indeedApplication());
    const [finding] = (await s.findings()).open;
    expect(finding).toMatchObject({ kind: "new_application", status: "ready", name: "Maria Lopez", role: "House Cleaner", source: "Indeed", headline: "Maria Lopez applied for House Cleaner" });
    expect(finding.reported).toEqual(expect.arrayContaining([expect.stringMatching(/^Maria reports: "3 years residential cleaning"/)]));
    expect(finding.reported.join(" ")).not.toMatch(/verified/i);
    expect(finding.missing).toContain("Availability");
    expect(finding.prepared).toMatchObject({ to: MARIA, toKind: "direct", channel: "email", link: "apply", writtenBy: "template" });
    expect(finding.next).toContain("application link");
  });

  it("an employment inquiry: a reply with the open role and its link, and the person kept apart from applicants who applied", async () => {
    const s = await setup();
    await s.receive(inquiry());
    const [finding] = await s.ready();
    expect(finding).toMatchObject({ kind: "employment_inquiry", prepared: { kind: "inquiry_reply", to: ANA, link: "apply" } });
    expect(finding.prepared!.preview).toContain("- House Cleaner, Austin, TX");
    await send(s, finding.findingId);
    await flush(s.t);
    const [email] = emailsTo(ANA);
    expect(email.subject).toBe("Working at Alpha Cleaning");
    expect(email.text).toMatch(/\/c\/apply\//);
    expect((await s.applications())[0]).toMatchObject({ stage: "invited", role: "House Cleaner" });
  });

  it("with two open roles, the inquiry reply lists both and sends no link until they choose", async () => {
    const s = await setup();
    await s.as.mutation(api.hiringNeeds.create, { companyId: s.companyId, title: "Office Cleaner", responsibilities: "Offices at night.", location: "Austin, TX", requiredAvailability: "Evenings.", engagement: "contractor", openings: 1 });
    await s.receive(inquiry());
    const [finding] = await s.ready();
    expect(finding.prepared).toMatchObject({ link: null });
    expect(finding.prepared!.preview).toContain("House Cleaner");
    expect(finding.prepared!.preview).toContain("Office Cleaner");
    await send(s, finding.findingId);
    await flush(s.t);
    expect(emailsTo(ANA)[0].text).not.toMatch(/\/c\/apply\//);
    // Now waiting for them to say which: nothing more is prepared.
    expect((await s.findings()).open).toEqual([]);
  });

  it("a pay question is answered only with pay the Owner approved", async () => {
    const s = await setup();
    await invited(s);
    await s.receive(mail({ from: `Maria Lopez <${MARIA}>`, subject: "Re: Next step", text: "What does the job pay per hour?" }));
    let [finding] = (await s.findings()).open;
    // No approved pay: nothing is prepared and nothing is guessed.
    expect(finding).toMatchObject({ kind: "pay_question", status: "needs_attention", prepared: null });
    await s.as.mutation(api.hiringNeeds.setCompensation, { companyId: s.companyId, needId: s.needId, pay: { kind: "share", shareBps: 4000 } });
    await s.as.mutation(api.recruiterFindings.refreshOne, { companyId: s.companyId, applicationId: finding.applicationId });
    [finding] = await s.ready();
    expect(finding).toMatchObject({ kind: "pay_question", prepared: { kind: "pay_reply", to: MARIA } });
    expect(finding.prepared!.preview).toContain("40% of each job's price");
    await send(s, finding.findingId);
    await flush(s.t);
    expect(emailsTo(MARIA).at(-1)!.text).toContain("pays 40% of each job's price");
    // Answered: reminders are no longer paused.
    expect((await s.detail(finding.applicationId)).waitingOnReply).toBe(false);
  });

  it("availability given: offers interview times when there are some, and says to add times when there are none", async () => {
    const s = await setup();
    await invited(s);
    await s.receive(mail({ from: `Maria Lopez <${MARIA}>`, subject: "Re: Next step", text: "I am available Tuesdays and Saturdays, mornings." }));
    let [finding] = (await s.findings()).open;
    expect(finding).toMatchObject({ kind: "availability_given", status: "needs_attention" });
    expect(finding.next).toContain("Add interview times");
    await s.as.mutation(api.interviews.addSlots, { companyId: s.companyId, interviewerId: await ownerId(s), startsAt: WEDNESDAY_2PM, endsAt: WEDNESDAY_2PM + HOUR });
    await s.as.mutation(api.recruiterFindings.refreshOne, { companyId: s.companyId, applicationId: finding.applicationId });
    [finding] = await s.ready();
    expect(finding.prepared).toMatchObject({ kind: "interview_times", link: "interview" });
    await send(s, finding.findingId);
    await flush(s.t);
    expect(emailsTo(MARIA).at(-1)!.subject).toContain("Choose a time");
  });

  it("a question it cannot answer from records waits for a person's words; their reply goes as theirs", async () => {
    const s = await setup();
    await invited(s);
    await s.receive(mail({ from: `Maria Lopez <${MARIA}>`, subject: "Re: Next step", text: "Do I need my own vacuum?" }));
    const [finding] = (await s.findings()).open;
    expect(finding).toMatchObject({ kind: "applicant_question", status: "needs_attention", prepared: { kind: "question_reply", body: "" } });
    expect(await send(s, finding.findingId)).toMatchObject({ ok: false, detail: "Write the message first." });
    await s.as.mutation(api.recruiterFindings.saveDraft, { companyId: s.companyId, findingId: finding.findingId, subject: "Re: your application", body: "No, we bring all equipment." });
    expect((await s.ready())[0]).toMatchObject({ findingId: finding.findingId, prepared: { writtenBy: "person" } });
    expect(await send(s, finding.findingId)).toMatchObject({ ok: true });
    await flush(s.t);
    expect(emailsTo(MARIA).at(-1)!.text.startsWith("No, we bring all equipment.")).toBe(true);
  });

  it("an edited message keeps its link, and goes with the person's words", async () => {
    const s = await setup();
    await s.receive(indeedApplication());
    const [finding] = await s.ready();
    await send(s, finding.findingId, { subject: "Your application with us", body: "Hi Maria, thanks! Please fill this in." });
    await flush(s.t);
    const [email] = emailsTo(MARIA);
    expect(email.subject).toBe("Your application with us");
    expect(email.text).toMatch(/^Hi Maria, thanks! Please fill this in\.\n\nhttps?:\/\/\S+\/c\/apply\//);
    expect((await s.findings()).outcomes[0]).toMatchObject({ status: "sent", prepared: { writtenBy: "person" } });
  });

  it("bulk send checks each one again: a withdrawn applicant's message is refused and the rest still go", async () => {
    const s = await setup();
    await s.receive(indeedApplication({ id: "a" }), indeedApplication({ id: "b", text: "Lee Wong applied to House Cleaner.\nEmail: lee.wong@example.test\nApplication ID: IND-2" }));
    const ready = await s.ready();
    expect(ready).toHaveLength(2);
    // Lee withdraws after the list was shown and before Send.
    const lee = ready.find((row) => row.name === "Lee Wong")!;
    await s.as.mutation(api.applications.close, { companyId: s.companyId, applicationId: lee.applicationId, reason: "other", note: "Withdrew by phone" });
    const results = await s.as.mutation(api.recruiterFindings.sendMany, { companyId: s.companyId, findingIds: ready.map((row) => row.findingId) });
    expect(results.filter((row) => row.ok)).toHaveLength(1);
    expect(results.find((row) => row.findingId === lee.findingId)).toMatchObject({ ok: false });
    await flush(s.t);
    expect(emailsTo("lee.wong@example.test")).toEqual([]);
    expect(emailsTo(MARIA)).toHaveLength(1);
  });

  it("only Owners and Managers send, and only their own company's", async () => {
    const s = await setup();
    await s.receive(indeedApplication());
    const [finding] = await s.ready();
    const office = await s.office();
    expect(await refusal(office.mutation(api.recruiterFindings.send, { companyId: s.companyId, findingId: finding.findingId }))).toBeTruthy();
    const other = await company(s.t, "owner-b", "Bravo Cleaning");
    expect(await refusal(other.as.mutation(api.recruiterFindings.send, { companyId: other.companyId, findingId: finding.findingId }))).toBeTruthy();
    expect((await other.as.query(api.recruiterFindings.list, { companyId: other.companyId })).open).toEqual([]);
    expect(mockEmails).toEqual([]);
  });

  it("nothing is prepared for someone who asked not to be contacted, and an earlier prepared message can no longer go", async () => {
    const s = await setup();
    const { applicationId } = await invited(s);
    await later(s.t, 49 * HOUR);
    const [reminder] = await s.ready();
    expect(reminder.kind).toBe("incomplete_application");
    await s.receive(mail({ from: `Maria Lopez <${MARIA}>`, subject: "Re: Next step", text: "Please stop emailing me." }));
    expect((await s.findings()).open.filter((row) => row.applicationId === applicationId)).toEqual([]);
    expect(await send(s, reminder.findingId)).toMatchObject({ ok: false });
    expect(emailsTo(MARIA)).toHaveLength(1);
  });

  it("automation, once switched on, sends without asking; switched off, it prepares and waits", async () => {
    const s = await setup();
    await s.receive(inquiry());
    expect(emailsTo(ANA)).toEqual([]);
    await s.allow("recruiter.reply_inquiry");
    await s.receive(mail({ from: "Ben Ito <ben.ito@example.test>", subject: "Looking for work", text: "Are you hiring? I am looking for work.\nBen" }));
    expect(emailsTo("ben.ito@example.test")).toHaveLength(1);
    expect((await s.findings()).outcomes.find((row) => row.name === "Ben Ito")).toMatchObject({ automatic: true });
    // Paused, Recruiter sends nothing by itself, even with the setting on.
    await s.as.mutation(api.companies.pauseAgent, { companyId: s.companyId, agent: "recruiter" });
    await s.receive(mail({ from: "Cy Moss <cy.moss@example.test>", subject: "Job inquiry", text: "Hello, are you hiring cleaners?\nCy" }));
    expect(emailsTo("cy.moss@example.test")).toEqual([]);
  });

  it("shows what the email service said, kept apart from what was planned", async () => {
    const s = await setup();
    await s.receive(indeedApplication());
    const [finding] = await s.ready();
    await send(s, finding.findingId);
    await flush(s.t);
    const [done] = (await s.findings()).outcomes;
    expect(done).toMatchObject({ status: "sent", delivery: { status: "delivered" }, automatic: false });
  });
});
