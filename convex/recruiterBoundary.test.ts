/**
 * @vitest-environment edge-runtime
 *
 * The recruiting boundary (convex/lib/recruiter/boundary.ts): what Recruiter may open in a connected
 * mailbox, and that every way of reading applies the same rule.
 *
 * INVENTED FIXTURES: every Indeed and ZipRecruiter message here is made up from general knowledge of those
 * notices, not taken from real mail (docs/recruiter/07-real-samples.md). Passing says the rules behave as
 * written, not that real notices read this way.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeGoogle } from "../tests/fakeGoogle";
import { HOUR, indeedApplication, mail, MONDAY_10AM, recruiterTestEnv, setup, zipApplication } from "../tests/recruiterHarness";
import { api } from "./_generated/api";
import { mockEmails } from "./lib/messaging/email";
import { discoveryOf, gate, subjectSaysHiring, type Known } from "./lib/recruiter/boundary";
import { gmailConnector, scopeQuery } from "./lib/recruiter/gmail";

const NOBODY: Known = { applicant: false, thread: false, customer: false, cleaner: false };
const ask = (from: string, subject: string, known: Partial<Known> = {}, mode: "hiring_inbox" | "label" | "search" = "search") => gate({ header: { from, subject }, mode, own: "hiring@alpha.test", sources: [], known: { ...NOBODY, ...known } });

describe("the recruiting boundary, from sender and subject alone", () => {
  it("reads job-board applications, and never a board's advertising or its suggested candidates", () => {
    expect(ask("Indeed <no-reply@indeed.com>", "New application for House Cleaner - Austin, TX")).toMatchObject({ verdict: "read", classification: "new_application", source: "indeed", attachments: true });
    expect(ask("Jordan Kim via ZipRecruiter <jordan.k.8f3a@reply.ziprecruiter.com>", "New candidate: Jordan Kim for House Cleaner")).toMatchObject({ verdict: "read", classification: "new_application", source: "ziprecruiter" });
    // A recommendation is a person who has NOT applied: not intake.
    expect(ask("ZipRecruiter <no-reply@ziprecruiter.com>", "5 recommended candidates for House Cleaner")).toMatchObject({ verdict: "skip", classification: "suggested_candidate" });
    for (const subject of ["Sponsor your job to get 3x more applicants", "Your weekly summary", "Your subscription renews soon", "Job alerts for you"]) {
      expect([subject, ask("Indeed <no-reply@indeed.com>", subject).verdict]).toEqual([subject, "skip"]);
    }
  });

  it("reads a direct application or employment inquiry from a personal address", () => {
    expect(ask("Chris Park <chris.park@example.test>", "Application for the House Cleaner position")).toMatchObject({ verdict: "read", classification: "new_application", attachments: true });
    expect(ask("Ana Ruiz <ana.ruiz@example.test>", "Are you hiring cleaners?")).toMatchObject({ verdict: "read" });
    expect(ask("Ana Ruiz <ana.ruiz@example.test>", "Looking for work")).toMatchObject({ verdict: "read" });
  });

  it("leaves customers, personal mail, invoices and newsletters alone", () => {
    expect(ask("Pat <pat@example.test>", "Can we book a cleaning for Friday?")).toMatchObject({ verdict: "skip" });
    expect(ask("Pat <pat@example.test>", "Re: estimate", { customer: true })).toMatchObject({ verdict: "skip" });
    expect(ask("Aunt Rosa <rosa@family.test>", "Dinner on Sunday?")).toMatchObject({ verdict: "skip" });
    expect(ask("Billing <billing@supplier.test>", "Invoice #4410 is ready")).toMatchObject({ verdict: "skip" });
    expect(ask("News <newsletter@cleaning-weekly.test>", "This week's hiring tips")).toMatchObject({ verdict: "skip" });
    // A working cleaner writing about supplies or a job is operations, not hiring.
    expect(ask("Sam <sam.cleaner@example.test>", "Running low on supplies", { cleaner: true })).toMatchObject({ verdict: "skip" });
    expect(ask("Sam <sam.cleaner@example.test>", "Question about Saturday's job", { cleaner: true })).toMatchObject({ verdict: "skip" });
  });

  it("keeps an ambiguous subject as possibly hiring-related, never opened", () => {
    expect(ask("Ana <ana.ruiz@example.test>", "Quick question about a job")).toMatchObject({ verdict: "possible" });
    expect(ask("Indeed <indeedapply@indeed.com>", "Maria Lopez is interested in House Cleaner")).toMatchObject({ verdict: "possible", source: "indeed" });
    expect(ask("LinkedIn <jobs-noreply@linkedin.com>", "New application: House Cleaner from Maria Lopez")).toMatchObject({ verdict: "possible" });
    // In a mailbox kept for hiring, a person writing in with a vague subject might be applying; in a shared one, not.
    expect(ask("Ana <ana.ruiz@example.test>", "Hello", {}, "hiring_inbox")).toMatchObject({ verdict: "possible" });
    expect(ask("Ana <ana.ruiz@example.test>", "Hello", {}, "search")).toMatchObject({ verdict: "skip" });
  });

  it("treats who sent it as context, not permission: an applicant writing about a booking is not read by itself", () => {
    expect(ask("Maria <maria.lopez@example.test>", "Re: Next step for your House Cleaner application", { applicant: true })).toMatchObject({ verdict: "read", classification: "applicant_reply", attachments: false });
    expect(ask("Maria <maria.lopez@example.test>", "Saturday works for me", { applicant: true })).toMatchObject({ verdict: "read", classification: "applicant_reply" });
    expect(ask("Maria <maria.lopez@example.test>", "Book a cleaning for my mom's house", { applicant: true })).toMatchObject({ verdict: "possible" });
    // Mail in a conversation already filed under an application is read, whatever its subject.
    expect(ask("Someone <x@example.test>", "Saturday", { thread: true })).toMatchObject({ verdict: "read", classification: "applicant_reply" });
    // A new notice from a board about a known person is a new notice, not their reply.
    expect(ask("Indeed <no-reply@indeed.com>", "New application for Office Cleaner", { applicant: true })).toMatchObject({ verdict: "read", classification: "new_application" });
    // The mailbox's own mail is never anyone's application.
    expect(ask("Alpha <hiring@alpha.test>", "Application received")).toMatchObject({ verdict: "skip", classification: "unrelated" });
  });

  it("names its words in one place, shared with the provider-side search", () => {
    expect(subjectSaysHiring("Résumé attached")).toBe("yes");
    expect(subjectSaysHiring("Your order has shipped")).toBe("no");
    expect(scopeQuery({ mode: "search" })).toContain("from:indeed.com");
    expect(scopeQuery({ mode: "search" })).toContain("-category:promotions");
    expect(scopeQuery({ mode: "label", folder: "Hiring" })).toBe(' label:"Hiring"');
    expect(scopeQuery({ mode: "hiring_inbox" })).toBe("");
    // Connections from before modes: a label is kept; a whole unlabelled inbox is searched narrowly.
    expect(discoveryOf({ folder: "Hiring" })).toBe("label");
    expect(discoveryOf({})).toBe("search");
    expect(discoveryOf({ discovery: "hiring_inbox" })).toBe("hiring_inbox");
  });
});

describe("the same boundary on every read", () => {
  const scope = { address: "hiring@alpha-cleaning.test", after: MONDAY_10AM - HOUR };
  const message = (id: string, at: number, extra: Record<string, unknown> = {}) => ({ id, receivedAt: at, from: "Indeed <no-reply@indeed.com>", subject: "New application for House Cleaner", text: "Maria Lopez applied.", attachments: [], ...extra });

  it("in label mode, the scan and the history updates both require the label, and a label added later is seen", async () => {
    const google = fakeGoogle();
    google.add(message("in", MONDAY_10AM, { labels: ["Label_7"] }));
    google.add(message("later", MONDAY_10AM + 500));
    const gmail = gmailConnector({ token: "access-1", fetch: google.fetch });
    const labelScope = { ...scope, folder: "Hiring", mode: "label" as const };
    const first = await gmail.list(labelScope, null, 25);
    expect(first.headers.map((row) => row.id)).toEqual(["in"]);
    // An unlabelled message arriving afterwards is not read through history either.
    google.add(message("unlabelled", MONDAY_10AM + 1000));
    const second = await gmail.list(labelScope, first.cursor, 25);
    expect(second.headers.map((row) => row.id)).toEqual([]);
    // The Owner files the earlier message under Hiring: history now hands it over.
    google.label("later", "Label_7");
    expect((await gmail.list(labelScope, second.cursor, 25)).headers.map((row) => row.id)).toEqual(["later"]);
  });

  it("in search mode, Gmail is asked for recruiting mail only, and history is held to the same gate afterwards", async () => {
    const google = fakeGoogle();
    const gmail = gmailConnector({ token: "access-1", fetch: google.fetch });
    await gmail.list({ ...scope, mode: "search" }, null, 25);
    expect(google.state.queries[0]).toMatch(/\{from:indeed\.com .*subject:application .*\}/);
    expect(google.state.queries[0]).toContain("-category:promotions");
  });

  it("files a customer's, a cleaner's and a personal email as nothing, from the scan and from later reads alike", async () => {
    const undo = recruiterTestEnv();
    try {
      const s = await setup();
      await s.t.run(async (ctx) => {
        await ctx.db.insert("customers", { companyId: s.companyId, name: "Pat Client", kind: "home", email: "pat.client@example.test", status: "active", createdAt: Date.now() });
        await ctx.db.insert("cleaners", { companyId: s.companyId, name: "Sam Cleaner", email: "sam.cleaner@example.test", engagement: "contractor", status: "ready", skills: [], serviceAreas: [], createdAt: Date.now() });
      });
      const unrelated = [
        mail({ id: "cust", from: "Pat Client <pat.client@example.test>", subject: "Re: your application of the deep clean discount", text: "When are you coming?" }),
        mail({ id: "cleaner", from: "Sam Cleaner <sam.cleaner@example.test>", subject: "Applying the new checklist", text: "Supplies are low." }),
        mail({ id: "personal", from: "Rosa <rosa@family.test>", subject: "Dinner on Sunday?", text: "Bring the kids." }),
      ];
      // The first read, then the same kinds of mail arriving later: the same answer both times.
      await s.receive(...unrelated);
      await s.receive(...unrelated.map((row) => ({ ...row, id: `${row.id}-later` })));
      expect(s.inbox.fetched).toEqual([]);
      expect(await s.applications()).toEqual([]);
      const rows = await s.t.run(async (ctx) => ctx.db.query("sourceMessages").collect());
      expect(rows.every((row) => row.classification === "unrelated" && row.subject === undefined && row.fromAddress === undefined)).toBe(true);
    } finally {
      undo();
    }
  });
});

describe("what is read once the boundary lets a message through", () => {
  let undo: () => void;
  beforeEach(() => {
    undo = recruiterTestEnv();
  });
  afterEach(() => undo());

  it("keeps a person asking about work apart from a person who applied", async () => {
    const s = await setup();
    await s.receive(
      mail({ id: "ask", from: "Ana Ruiz <ana.ruiz@example.test>", subject: "Are you hiring cleaners?", text: "Hi, are you hiring? I have cleaned homes for two years.\nAna" }),
      mail({ id: "apply", from: "Chris Park <chris.park@example.test>", subject: "Application for the House Cleaner position", text: "I would like to apply for the House Cleaner position.\nChris Park" }),
    );
    const rows = await s.t.run(async (ctx) => ctx.db.query("applications").collect());
    expect(rows.map((row) => [row.source, row.intake ?? "application"]).sort()).toEqual([
      ["direct", "application"],
      ["direct", "inquiry"],
    ]);
    const seen = await s.as.query(api.recruiter.inboxMessages, { companyId: s.companyId });
    expect(seen.messages.map((row) => row.classification).sort()).toEqual(["employment_inquiry", "new_application"]);
  });

  it("opens attachments for an application and not for a reply", async () => {
    const s = await setup();
    await s.receive(indeedApplication({ id: "app", attachments: [{ name: "resume.txt", contentType: "text/plain", size: 30, text: "Maria Lopez" }] }));
    await s.approveAll();
    await s.receive(mail({ id: "reply", from: "Maria Lopez <maria.lopez@example.test>", subject: "Re: Next step", text: "Here is my availability", attachments: [{ name: "notes.txt", contentType: "text/plain", size: 10, text: "Saturdays" }] }));
    expect(s.inbox.fetched).toEqual(["app", "reply"]);
    expect(s.inbox.attachmentsRead).toEqual(["app"]);
  });

  it("follows an established conversation by its thread, whatever the subject", async () => {
    const s = await setup();
    await s.receive(zipApplication({ id: "z1", threadId: "thread-9" }));
    await s.receive(mail({ id: "z2", threadId: "thread-9", from: "Someone <other.address@example.test>", subject: "Saturday", text: "Saturday works." }));
    expect(s.inbox.fetched).toEqual(["z1", "z2"]);
    const seen = await s.as.query(api.recruiter.inboxMessages, { companyId: s.companyId });
    expect(seen.messages.find((row) => row.subject === "Saturday")).toMatchObject({ classification: "applicant_reply" });
    expect(mockEmails.filter((row) => row.to === "other.address@example.test")).toEqual([]);
  });
});
