/**
 * @vitest-environment edge-runtime
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { careSetup, CUSTOMER_PHONE, DAY, HOUR, TUESDAY_10, WEDNESDAY_10, WEEK } from "../tests/careHarness";
import { dispatchTestEnv, flush } from "../tests/dispatchHarness";
import { company, refusal } from "../tests/harness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { NOT_FOUND } from "./lib/errors";
import { mockOutbox } from "./lib/messaging/provider";

let undo: () => void;
beforeEach(() => {
  undo = dispatchTestEnv();
});
afterEach(() => undo());

describe("Client Care: answers from the record", () => {
  it("asks which visit when a client with several bookings asks something only one can answer, then answers that one", async () => {
    const s = await careSetup();
    const first = await s.visit(TUESDAY_10, { accepted: true });
    await s.visit(WEDNESDAY_10);
    await s.text("Who is assigned to my cleaning?");
    let [request] = await s.requests();
    expect(request).toMatchObject({ category: "appointment", status: "waiting_customer" });
    expect(request.pending?.kind).toBe("which_visit");
    expect(s.replies().at(-1)).toMatch(/this is Alpha Cleaning's assistant\. Which visit do you mean\? 1\) Tue, Mar 2 at 10:00 AM 2\) Wed, Mar 3 at 10:00 AM/);
    await s.text("1");
    [request] = await s.requests();
    expect(request).toMatchObject({ status: "resolved", jobId: first });
    // Only an accepted cleaner is named, and only by first name.
    expect(s.replies().at(-1)).toContain("Lena is confirmed for Tue, Mar 2 at 10:00 AM.");
    expect(await s.requests()).toHaveLength(1);
  });

  it("says exactly what the visit's record says: booked, not yet confirmed, and never an arrival it doesn't have", async () => {
    const s = await careSetup();
    await s.visit(TUESDAY_10);
    await s.text("Has my cleaning on Tuesday been confirmed?");
    expect(s.replies().at(-1)).toContain("Your visit is booked for Tue, Mar 2 at 10:00 AM. A cleaner hasn't been confirmed for it yet.");
    expect(s.replies().at(-1)).not.toMatch(/on (?:the|their) way|minutes away|arriv\w+ (?:in|at about)/i);
    const [request] = await s.requests();
    expect(request.status).toBe("resolved");
    expect(request.facts.find((f) => f.key === "visit")).toMatchObject({ value: "booked", basis: "record" });
  });

  it("says a visit held by a migration is not confirmed", async () => {
    const s = await careSetup();
    const jobId = await s.visit(TUESDAY_10, { accepted: true });
    await s.t.run(async (ctx) => {
      const migrationId = await ctx.db.insert("migrations", { companyId: s.companyId, status: "imported", step: "review", source: null, wants: [], timezone: "America/Chicago", timezoneConfirmed: true, dateOrder: null, serviceMap: [], groups: [], notes: [], dirty: false, revision: 1, createdBy: { kind: "system" }, createdAt: Date.now(), updatedAt: Date.now() } as never);
      await ctx.db.patch(jobId, { migration: { migrationId, held: true } });
    });
    await s.text("Is my cleaning Tuesday still on?");
    expect(s.replies().at(-1)).toContain("isn't confirmed yet");
  });
});

describe("Client Care: preferences and access", () => {
  it("puts a one-visit preference on that visit only, after the Owner approves, and leaves the series alone", async () => {
    const s = await careSetup();
    const { jobs } = await s.weeklyPlan([TUESDAY_10, TUESDAY_10 + WEEK]);
    await s.text("Please don't clean the guest bedroom this Tuesday only");
    const [request] = await s.requests();
    expect(request).toMatchObject({ category: "preference", status: "waiting_owner" });
    // A change to a visit starts at Ask me first; nothing changed and nothing was sent yet.
    expect((await s.job(jobs[0])).instructions ?? "").not.toContain("guest bedroom");
    const [pending] = await s.pending();
    expect(pending).toMatchObject({ action: "care.update_preferences", status: "pending" });
    expect(await s.approveAll()).toEqual([expect.objectContaining({ ok: true })]);
    expect((await s.job(jobs[0])).instructions).toContain("guest bedroom");
    expect((await s.job(jobs[1])).instructions ?? "").not.toContain("guest bedroom");
    expect(s.replies().at(-1)).toContain("Your other visits are unchanged.");
    expect((await s.requests())[0].status).toBe("resolved");
  });

  it("asks whether a preference is for one visit or every visit when the client doesn't say", async () => {
    const s = await careSetup();
    await s.visit(TUESDAY_10);
    await s.text("Please use unscented products");
    const [request] = await s.requests();
    expect(request.pending?.kind).toBe("which_scope");
    expect(s.replies().at(-1)).toMatch(/Should that apply 1\) Just the next visit/);
  });
});

describe("Client Care: durable, once", () => {
  it("handles one delivery once, however often the webhook or the worker repeats it", async () => {
    const s = await careSetup();
    await s.visit(TUESDAY_10);
    await s.text("When are you coming?", CUSTOMER_PHONE, "evt-dup-1");
    await s.text("When are you coming?", CUSTOMER_PHONE, "evt-dup-1");
    expect(await s.careMessages()).toHaveLength(1);
    expect(await s.requests()).toHaveLength(1);
    expect(await s.outbound()).toHaveLength(1);
    // The run asked again does nothing new.
    const runs = await s.t.run(async (ctx) => (await ctx.db.query("careRuns").collect()).filter((r) => r.kind === "read"));
    await s.t.action(internal.clientCareWork.read, { runId: runs[0]._id });
    await s.sweep();
    expect(await s.outbound()).toHaveLength(1);
    expect(s.replies()).toHaveLength(1);
  });

  it("keeps a replayed or imported message for the record and starts nothing", async () => {
    const s = await careSetup();
    await s.visit(TUESDAY_10);
    await s.t.mutation(internal.inbound.telnyx, { eventId: "evt-old-1", to: s.smsNumber, from: CUSTOMER_PHONE, body: "When are you coming?", receivedAt: Date.now() - 5 * DAY });
    await flush(s.t);
    expect((await s.careMessages())[0]).toMatchObject({ status: "skipped" });
    expect(await s.requests()).toHaveLength(0);
    expect(s.replies()).toHaveLength(0);
  });

  it("keeps everything while Client Care is paused, does nothing on its own, and works it when resumed", async () => {
    const s = await careSetup();
    await s.visit(TUESDAY_10);
    await s.as.mutation(api.companies.pauseAgent, { companyId: s.companyId, agent: "customer-care" });
    await s.text("When are you coming?");
    expect(await s.careMessages()).toHaveLength(1);
    expect(await s.requests()).toHaveLength(0);
    expect(s.replies()).toHaveLength(0);
    const overview = await s.as.query(api.clientCare.overview, { companyId: s.companyId, asOf: Date.now() });
    expect(overview.agent.paused).toBe(true);
    expect(overview.counts.unread).toBe(1);
    await s.as.mutation(api.companies.resumeAgent, { companyId: s.companyId, agent: "customer-care" });
    vi.setSystemTime(Date.now() + 3 * 60_000);
    await s.sweep();
    expect(await s.requests()).toHaveLength(1);
    expect(s.replies()).toHaveLength(1);
  });
});

describe("Client Care: rescheduling", () => {
  it("offers only times capacity allows, and re-checks the chosen one when it is carried out", async () => {
    const s = await careSetup();
    await s.policy(24);
    const jobId = await s.visit(WEDNESDAY_10);
    await s.text("Can you move Wednesday's cleaning to Thursday?");
    let [request] = await s.requests();
    expect(request.pending?.kind).toBe("choose_time");
    expect(s.replies().at(-1)).toMatch(/I can move your Wed, Mar 3 at 10:00 AM visit to 1\) Thu, Mar 4 at 10:00 AM/);
    await s.text("1");
    // Moving a visit starts at Ask me first: the time shown is not a reservation, and nothing moved yet.
    expect((await s.pending()).map((a) => a.action)).toEqual(["care.reschedule_visit"]);
    expect((await s.job(jobId)).startsAt).toBe(WEDNESDAY_10);
    // Before anyone approves, the team's Thursday goes.
    for (const cleanerId of Object.values(s.cleaners)) await s.as.mutation(api.availability.setWeek, { companyId: s.companyId, cleanerId, windows: [1, 2, 3, 5].map((weekday) => ({ weekday, startMinute: 8 * 60, endMinute: 17 * 60 })) });
    const [carried] = await s.approveAll();
    expect(carried).toMatchObject({ ok: false });
    expect(carried!.detail).toContain("no longer available");
    expect((await s.job(jobId)).startsAt).toBe(WEDNESDAY_10);
    // Care offers what is open now, instead of the time that went.
    await s.sweep();
    [request] = await s.requests();
    expect(request.pending?.kind).toBe("choose_time");
    expect(s.replies().at(-1)).toContain("Thu, Mar 4 at 10:00 AM isn't available. These times are open:");
    expect(request.pending!.options.length).toBeGreaterThan(0);
    expect(request.pending!.options.every((o) => !o.label.startsWith("Thu"))).toBe(true);
  });

  it("moves the visit once approved, keeping its price, and tells the client", async () => {
    const s = await careSetup();
    await s.policy(24);
    const jobId = await s.visit(WEDNESDAY_10);
    const before = await s.job(jobId);
    await s.allow("care.reschedule_visit", "execute_and_report");
    await s.text("Please reschedule Wednesday's cleaning to Thursday at 11am");
    const after = await s.job(jobId);
    expect(after.startsAt).toBe(WEDNESDAY_10 + DAY + HOUR);
    expect(after.priceCents).toBe(before.priceCents);
    expect(s.replies().at(-1)).toContain("Done: your visit is moved to Thu, Mar 4 at 11:00 AM. Same service and price.");
    expect((await s.requests())[0].status).toBe("resolved");
  });

  it("sends a change inside the notice window to the Owner instead of carrying it out", async () => {
    const s = await careSetup();
    await s.policy(48);
    const jobId = await s.visit(TUESDAY_10);
    await s.allow("care.reschedule_visit", "execute");
    await s.text("Can you move Tuesday's cleaning to Thursday?");
    const [request] = await s.requests();
    expect(request.status).toBe("waiting_owner");
    expect(request.blocker).toContain("Less than 48 hours before the visit");
    expect((await s.job(jobId)).startsAt).toBe(TUESDAY_10);
  });

  it("never carries out an approval for a request the client has since changed", async () => {
    const s = await careSetup();
    await s.policy(24);
    const jobId = await s.visit(WEDNESDAY_10);
    await s.text("Please reschedule Wednesday's cleaning to Thursday at 11am");
    const [first] = await s.pending();
    await s.text("Actually can we reschedule Wednesday to Friday at 11am instead?");
    // The earlier approval was withdrawn when the client changed what they asked for.
    expect(await refusal(s.as.mutation(api.approvals.decide, { companyId: s.companyId, approvalId: first._id, decision: "approved" }))).toMatch(/already expired/);
    expect((await s.job(jobId)).startsAt).toBe(WEDNESDAY_10);
    const [second] = await s.pending();
    expect(second.summary).toContain("Fri, Mar 5 at 11:00 AM");
  });
});

describe("Client Care: skips and cancellations", () => {
  it("skips one visit of a recurring plan and leaves the rest of the series as it is", async () => {
    const s = await careSetup();
    await s.policy(24);
    const { planId, jobs } = await s.weeklyPlan([TUESDAY_10, TUESDAY_10 + WEEK, TUESDAY_10 + 2 * WEEK]);
    await s.text("Please skip Tuesday's cleaning");
    expect((await s.pending()).map((a) => a.action)).toEqual(["care.skip_visit"]);
    await s.approveAll();
    expect((await s.job(jobs[0])).status).toBe("cancelled");
    expect((await s.job(jobs[0])).skipped).toBe(true);
    expect((await s.job(jobs[1])).status).toBe("scheduled");
    expect((await s.job(jobs[2])).status).toBe("scheduled");
    const plan = await s.t.run(async (ctx) => (await ctx.db.get(planId))!);
    expect(plan.state).toBe("active");
    expect(s.replies().at(-1)).toContain("Your other scheduled visits stay as they are.");
  });

  it("asks what 'cancel' means instead of assuming the whole plan", async () => {
    const s = await careSetup();
    await s.policy(24);
    await s.weeklyPlan([TUESDAY_10, TUESDAY_10 + WEEK]);
    await s.text("I need to cancel");
    const [request] = await s.requests();
    expect(request.pending?.kind).toBe("which_change");
    expect(s.replies().at(-1)).toMatch(/1\) Just the visit on Tue, Mar 2 at 10:00 AM 2\) Pause the service for a while 3\) End the service/);
  });

  it("ends the plan as the client asked, tells Retention, and sends no retention offer", async () => {
    const s = await careSetup();
    await s.policy(24);
    const { planId, jobs } = await s.weeklyPlan([TUESDAY_10, TUESDAY_10 + WEEK]);
    await s.text("I want to cancel my service");
    const signals = await s.signals();
    expect(signals.filter((row) => row.kind === "cancel_request")).toHaveLength(1);
    expect((await s.pending()).map((a) => a.action)).toEqual(["care.change_plan"]);
    await s.approveAll();
    const plan = await s.t.run(async (ctx) => (await ctx.db.get(planId))!);
    expect(plan.state).toBe("ended");
    for (const jobId of jobs) expect((await s.job(jobId)).status).toBe("cancelled");
    expect(s.replies().at(-1)).toContain("your recurring service ends");
    const offers = await s.t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.purpose === "return_offer"));
    expect(offers).toEqual([]);
  });
});

describe("Client Care: complaints", () => {
  it("acknowledges without findings, opens one linked recovery case, and keeps one case when the client writes again", async () => {
    const s = await careSetup();
    const jobId = await s.completed({ scope: "A full clean." });
    await s.text("The bathroom still looks dirty");
    let [request] = await s.requests();
    expect(request).toMatchObject({ category: "complaint", status: "waiting_team", jobId });
    expect(request.retentionCaseId).toBeTruthy();
    const ack = s.replies().at(-1)!;
    expect(ack).toMatch(/I'm sorry it wasn't right after your visit on .*I've passed it to our team to review, and I'll update you by/);
    expect(ack).not.toMatch(/refund|re-?clean|our fault|we will (?:come|send)/i);
    await s.text("Really disappointed, the bathroom is still dirty");
    const cases = (await s.cases()).filter((c) => c.kind === "recovery");
    expect(cases).toHaveLength(1);
    expect(await s.requests()).toHaveLength(1);
    expect(s.replies().at(-1)).toContain("I've added that to the review.");
    [request] = await s.requests();
    expect(request.retentionCaseId).toBe(cases[0]._id);
  });

  it("escalates a serious concern as urgent and promises nothing", async () => {
    const s = await careSetup();
    await s.completed({ scope: "A full clean." });
    await s.text("Your cleaner broke my vase");
    const [request] = await s.requests();
    expect(request.urgency).toBe("urgent");
    expect(s.replies().at(-1)).toContain("I've passed this straight to the owner");
  });

  it("reopens a resolved request when the client says it isn't done", async () => {
    const s = await careSetup();
    await s.completed({ scope: "A full clean." });
    await s.text("The bathroom still looks dirty");
    const [request] = await s.requests();
    await s.as.mutation(api.clientCare.resolve, { companyId: s.companyId, requestId: request._id, note: "Re-cleaned." });
    await s.text("The bathroom is still not fixed");
    const rows = await s.requests();
    expect(rows).toHaveLength(1);
    expect(rows[0].reopened).toHaveLength(1);
    expect(rows[0].status).not.toBe("resolved");
  });
});

describe("Client Care: invoices", () => {
  it("sends the existing invoice's record and link, and creates, charges or marks nothing", async () => {
    const s = await careSetup();
    const invoiceId = await s.invoice(12000, { paidCents: 4000, depositCents: 4000 });
    await s.text("Can you send my invoice?");
    const reply = s.replies().at(-1)!;
    expect(reply).toContain("total $160.00, paid $40.00, balance $120.00");
    expect(reply).toMatch(/https?:\/\/\S+/);
    await s.text("I paid it yesterday");
    expect(s.replies().at(-1)).toContain("I've asked the office to check it.");
    const invoices = await s.t.run(async (ctx) => (await ctx.db.query("invoices").collect()).filter((i) => i.companyId === s.companyId));
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ _id: invoiceId, status: "open", totals: expect.objectContaining({ balanceCents: 12000, paidCents: 4000 }) });
  });
});

describe("Client Care: who holds the conversation", () => {
  it("stops a queued reply when a person takes the request over", async () => {
    const s = await careSetup();
    await s.visit(TUESDAY_10);
    await s.as.mutation(api.companies.pauseMessaging, { companyId: s.companyId });
    await s.text("When are you coming?");
    expect((await s.outbound()).map((m) => m.status)).toEqual(["held"]);
    const [request] = await s.requests();
    await s.as.mutation(api.clientCare.takeOver, { companyId: s.companyId, requestId: request._id });
    await s.as.mutation(api.companies.resumeMessaging, { companyId: s.companyId });
    await flush(s.t);
    expect((await s.outbound()).map((m) => m.status)).toEqual(["not_sent"]);
    expect(s.replies()).toEqual([]);
    const customer = await s.t.run(async (ctx) => (await ctx.db.get(s.place.customerId))!);
    expect(customer.conversationHeld).toBeTruthy();
  });

  it("leaves a client's reply on an open Sales inquiry to Sales", async () => {
    const s = await careSetup();
    await s.t.run(async (ctx) => {
      const { fileInquiry } = await import("./lib/sales/intake");
      const company = (await ctx.db.get(s.companyId))!;
      await fileInquiry(ctx, company, { contact: { name: "Dana Whitfield", phone: CUSTOMER_PHONE }, customerId: s.place.customerId, kind: "residential", source: { kind: "sms" }, inquiry: "Quote for a deep clean", receivedAt: Date.now(), channel: "sms", dedupeKey: "sales-open-1", actor: { kind: "system" } });
    });
    await s.text("When can you come for the deep clean?");
    expect(await s.careMessages()).toHaveLength(0);
    expect(await s.requests()).toHaveLength(0);
  });

  it("acts only within a contact's own authority and properties", async () => {
    const s = await careSetup();
    const other = await s.t.run(async (ctx) => ctx.db.insert("properties", { companyId: s.companyId, customerId: s.place.customerId, kind: "commercial", label: "North site", address: { line1: "9 North Rd", city: "Austin", region: "TX", postalCode: "78701" }, status: "active", createdAt: Date.now() } as never));
    await s.visit(TUESDAY_10);
    const north = await s.visit(WEDNESDAY_10, { propertyId: other as Id<"properties"> });
    const PAT = "+15125550188";
    // The client's own primary contact first (the first contact is always primary), then Pat, for the North site only.
    await s.as.mutation(api.clients.saveContact, { companyId: s.companyId, customerId: s.place.customerId, name: "Dana Whitfield", phone: CUSTOMER_PHONE, roles: ["primary"], propertyIds: [] });
    await s.as.mutation(api.clients.saveContact, { companyId: s.companyId, customerId: s.place.customerId, name: "Pat", phone: PAT, roles: ["site"], propertyIds: [other as Id<"properties">] });
    await s.as.mutation(api.consent.record, { companyId: s.companyId, recipient: { kind: "customer", id: s.place.customerId }, channel: "sms", category: "operational", status: "granted", source: "web_form", evidence: "Form." });
    await s.text("When are you coming?", PAT);
    const [ask] = await s.requests();
    expect(ask.authority).toMatchObject({ as: "contact", name: "Pat", roles: ["site"] });
    expect(ask.jobId).toBe(north);
    await s.policy(24);
    await s.allow("care.skip_visit", "execute");
    await s.text("Please skip Wednesday's cleaning", PAT);
    const skip = (await s.requests()).find((r) => r.category === "cancellation")!;
    expect(skip.status).toBe("waiting_owner");
    expect(skip.blocker).toContain("contact role doesn't allow");
    expect((await s.job(north)).status).toBe("scheduled");
  });
});

describe("Client Care: when the message doesn't go", () => {
  it("keeps a change that was made, retries only the message, and never makes the change twice", async () => {
    const s = await careSetup();
    await s.as.mutation(api.customers.update, { companyId: s.companyId, customerId: s.place.customerId, phone: "+15550100001" });
    const jobId = await s.visit(TUESDAY_10);
    await s.allow("care.update_preferences", "execute");
    await s.text("Please don't clean the guest bedroom this Tuesday only", "+15550100001");
    let [step] = (await s.steps()).filter((x) => x.kind === "preference");
    expect(step.status).toBe("partial");
    expect(step.parts.find((p) => p.name === "change")?.state).toBe("done");
    expect(step.parts.find((p) => p.name === "notify")?.state).toBe("failed");
    const [request] = await s.requests();
    expect(request.status).toBe("waiting_owner");
    expect(request.blocker).toContain("The message telling the client did not go");
    await s.as.mutation(api.clientCare.retry, { companyId: s.companyId, stepId: step._id });
    await flush(s.t);
    [step] = (await s.steps()).filter((x) => x.kind === "preference");
    expect((await s.job(jobId)).instructions!.match(/guest bedroom/g)).toHaveLength(1);
    expect((await s.outbound()).filter((m) => m.careStepId === step._id)).toHaveLength(2);
  });

  it("leaves an uncertain send uncertain and never sends it again by itself", async () => {
    const s = await careSetup();
    await s.as.mutation(api.customers.update, { companyId: s.companyId, customerId: s.place.customerId, phone: "+15550100006" });
    await s.visit(TUESDAY_10);
    await s.text("When are you coming?", "+15550100006");
    await s.t.mutation(internal.messaging.sweepStuck, {});
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await s.t.mutation(internal.messaging.sweepStuck, {});
    await flush(s.t);
    const [message] = await s.outbound();
    expect(message.status).toBe("unconfirmed");
    const [step] = await s.steps();
    expect(step.status).toBe("uncertain");
    expect((await s.as.mutation(api.clientCare.retry, { companyId: s.companyId, stepId: step._id })).ok).toBe(false);
    expect((await s.requests())[0].blocker).toContain("not known whether");
  });

  it("shows a channel that can't send on the request, and resolves nothing", async () => {
    const s = await careSetup();
    await s.visit(TUESDAY_10);
    await s.t.run(async (ctx) => {
      const profile = (await ctx.db.query("complianceProfiles").collect()).find((p) => p.companyId === s.companyId)!;
      await ctx.db.patch(profile._id, { messaging: { ...profile.messaging, registration: { ...profile.messaging.registration, status: "suspended" } } });
    });
    await s.text("When are you coming?");
    const [request] = await s.requests();
    expect(request.status).toBe("waiting_owner");
    expect(request.blocker).toMatch(/registration/);
    expect(s.replies()).toEqual([]);
  });
});

describe("Client Care: tenants", () => {
  it("never lets another company read or act on a request", async () => {
    const s = await careSetup();
    await s.visit(TUESDAY_10);
    await s.text("When are you coming?");
    const [request] = await s.requests();
    const other = await company(s.t, "owner-b", "Beta Cleaning");
    expect(await refusal(other.as.query(api.clientCare.detail, { companyId: other.companyId, requestId: request._id }))).toBe(NOT_FOUND);
    expect(await refusal(other.as.mutation(api.clientCare.takeOver, { companyId: other.companyId, requestId: request._id }))).toBe(NOT_FOUND);
    expect(await refusal(other.as.mutation(api.clientCare.close, { companyId: other.companyId, requestId: request._id, reason: "x" }))).toBe(NOT_FOUND);
    expect((await other.as.query(api.clientCare.list, { companyId: other.companyId })).rows).toEqual([]);
  });
});

export type { Id };
export { HOUR, mockOutbox };
