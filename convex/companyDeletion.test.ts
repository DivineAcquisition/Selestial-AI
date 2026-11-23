/**
 * @vitest-environment edge-runtime
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchTestEnv } from "../tests/dispatchHarness";
import { company, refusal, seedVisit, staffWith, start, withLinkSecret, type T } from "../tests/harness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { companyIndex, pagingIndex } from "./companyDeletion";
import { NOT_ALLOWED } from "./lib/errors";
import { tokenFor } from "./lib/dispatch/links";
import { checkSend } from "./lib/messaging/policy";
import { addressHash, DELETED_COMPANY, DELETION_PLAN, PLACEHOLDER } from "./lib/trust/companyDeletion";
import schema from "./schema";

const DAY = 24 * 60 * 60 * 1000;
const DESTROYER = { subject: "user_destroyer", email: "destroyer@selestial.example", name: "Dee Stroyer", emailVerified: true };
const PLAIN_ADMIN = { subject: "user_plain", email: "plain@selestial.example", name: "Plain Admin", emailVerified: true };

let undo = () => {};
beforeEach(() => {
  undo = dispatchTestEnv();
});
afterEach(() => {
  undo();
});

type Tables = Record<string, { validator: { fields?: Record<string, unknown> } }>;

/** Copies an existing row n times with changes, so seeded rows always pass their validators. */
async function clone(t: T, table: string, id: string, n: number, change: (i: number) => Record<string, unknown>) {
  return t.run(async (ctx) => {
    const db = ctx.db as unknown as { get(id: string): Promise<Record<string, unknown>>; insert(table: string, row: Record<string, unknown>): Promise<string> };
    const { _id, _creationTime, ...row } = await db.get(id);
    void _id;
    void _creationTime;
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) out.push(await db.insert(table, { ...row, ...change(i) }));
    return out;
  });
}

const PHONE = "+15125550100";
const EMAIL = "dana@example.com";

/** A company with several tables holding more than one batch of rows (batch size 5 in these tests). */
async function seeded(t: T, subject: string, name: string) {
  const c = await company(t, subject, name);
  const visit = await seedVisit(c.as, c.companyId);
  await t.run((ctx) => ctx.db.patch(visit.customerId, { email: EMAIL, phone: PHONE }));
  const customers = [visit.customerId as string, ...(await clone(t, "customers", visit.customerId, 11, (i) => ({ name: `Customer ${i}`, email: `c${i}@example.com`, phone: `+1512555${String(1000 + i)}` })))];
  const jobs = [visit.jobId as string, ...(await clone(t, "jobs", visit.jobId, 6, () => ({ instructions: "Key under the mat" })))];
  const seededIds = await t.run(async (ctx) => {
    const owner = (await ctx.db.query("members").withIndex("by_company", (q) => q.eq("companyId", c.companyId)).first())!;
    const assignmentId = await ctx.db.insert("assignments", { companyId: c.companyId, jobId: visit.jobId, cleanerId: visit.cleanerId, status: "accepted", scope: "x", payCents: 9000, offeredAt: 1, respondBy: 2 });
    const files: Id<"_storage">[] = [];
    for (let i = 0; i < 7; i += 1) {
      const storageId = await ctx.storage.store(new Blob([`photo ${i}`]));
      files.push(storageId);
      await ctx.db.insert("evidence", { companyId: c.companyId, jobId: visit.jobId, assignmentId, cleanerId: visit.cleanerId, kind: "before", storageId, clientKey: `k${i}`, uploadedAt: i });
    }
    for (let i = 0; i < 12; i += 1) {
      await ctx.db.insert("messages", { companyId: c.companyId, purpose: "offer", body: `Hi Dana, your visit at 12 Elm St (${i})`, dedupeKey: `d${i}`, status: "sent", attempts: 1, queuedAt: i, to: PHONE, customerId: visit.customerId });
    }
    for (let i = 0; i < 6; i += 1) await ctx.db.insert("suppressions", { companyId: c.companyId, channel: "sms", address: `+1512555${2000 + i}`, scope: "all", reason: "stop_keyword", at: i, note: "Said STOP" });
    await ctx.db.insert("contactPermissions", { companyId: c.companyId, recipient: { kind: "customer", id: visit.customerId }, channel: "sms", category: "operational", status: "granted", source: "web_form", recordedBy: { kind: "system" }, at: 1, evidence: "Dana ticked the box on 12 Elm St form" });
    const invoiceId = await ctx.db.insert("invoices", {
      companyId: c.companyId,
      customerId: visit.customerId,
      status: "paid",
      lines: [{ id: "l1", kind: "service", description: "Clean for Dana Whitfield", quantity: 1, unitCents: 16000, amountCents: 16000, taxable: false }],
      taxRateBps: 0,
      totals: { subtotalCents: 16000, discountCents: 0, taxCents: 0, totalCents: 16000, paidCents: 16000, refundedCents: 0, creditedCents: 0, balanceCents: 0, processingCents: 0 },
      revision: 1,
      memo: "Thanks Dana",
      createdAt: 1,
      updatedAt: 1,
    } as never);
    await ctx.db.insert("payments", { companyId: c.companyId, invoiceId, customerId: visit.customerId, amountCents: 16000, method: "card", source: "stripe", status: "succeeded", clientKey: "pay1", refundedCents: 0, createdAt: 1, updatedAt: 1 });
    for (let i = 0; i < 6; i += 1) await ctx.db.insert("events", { companyId: c.companyId, type: "message.sent", actor: { kind: "system" }, subject: { table: "companies", id: c.companyId }, subjectId: c.companyId, data: { note: "Texted Dana Whitfield", attempt: i, code: "sms" }, at: i });
    const connectionId = await ctx.db.insert("googleConnections", { companyId: c.companyId, googleSub: `sub-${subject}`, email: "office@example.com", status: "connected", grantedScopes: [], connectedBy: owner._id, connectedAt: 1 });
    await ctx.db.insert("googleCredentials", { companyId: c.companyId, connectionId, sealedRefreshToken: "sealed", createdAt: 1 });
    return { files, invoiceId, ownerId: owner._id };
  });
  return { ...c, visit, customers, jobs, ...seededIds };
}

/** The Owner's request, as Settings files it. */
async function requested(c: { as: ReturnType<T["withIdentity"]>; companyId: Id<"companies"> }, t: T) {
  const { reference } = await c.as.mutation(api.dataRights.requestCompanyDeletion, { companyId: c.companyId });
  return t.run(async (ctx) => (await ctx.db.query("trustRequests").withIndex("by_reference", (q) => q.eq("reference", reference)).unique())!._id);
}

async function setBatch(t: T, deletionId: Id<"companyDeletions">, batchSize: number) {
  await t.run((ctx) => ctx.db.patch(deletionId, { batchSize }));
}

const countOf = (t: T, table: "customers" | "evidence" | "messages" | "members" | "events" | "suppressions" | "jobs" | "properties", companyId: Id<"companies">) =>
  t.run(async (ctx) => (await (ctx.db.query(table) as unknown as { collect(): Promise<{ companyId?: string }[]> }).collect()).filter((row) => row.companyId === companyId).length);

describe("the retention classification", () => {
  it("covers every company table, and every field it names exists", () => {
    const tables = schema.tables as unknown as Tables;
    const companyTables = Object.keys(tables).filter((name) => tables[name].validator.fields && "companyId" in tables[name].validator.fields!);
    const planned = new Set(DELETION_PLAN.map((row) => row.table));
    expect(companyTables.filter((name) => !planned.has(name))).toEqual([]);
    expect(DELETION_PLAN.length).toBe(planned.size);
    for (const plan of DELETION_PLAN) {
      expect(plan.reason.length, plan.table).toBeGreaterThan(5);
      const fields = tables[plan.table]?.validator.fields;
      if (!fields) continue;
      for (const path of [...(plan.personal ?? []), ...(plan.hashed ?? [])]) expect(fields[path.split(".")[0]], `${plan.table}.${path}`).toBeDefined();
      // A table without a companyId index is only ever a small one, or left uncounted.
      if (!companyIndex(plan.table)) expect(plan.treatment === "delete" || plan.uncounted, plan.table).toBe(true);
      // Rows that stay are paged through an index holding none of the fields rewritten, so none is visited twice.
    }
    expect(DELETION_PLAN.filter((plan) => plan.treatment !== "delete" && !plan.uncounted && tables[plan.table] && !pagingIndex(plan)).map((plan) => plan.table)).toEqual([]);
  });

  it("keeps money, consent and Selestial's records, and deletes the rest", () => {
    const by = (table: string) => DELETION_PLAN.find((row) => row.table === table)!.treatment;
    for (const table of ["invoices", "payments", "refunds", "teamPayments", "suppressions", "contactPermissions", "messages", "billingAccounts", "trustRequests"]) expect(by(table), table).toBe("retain");
    for (const table of ["customers", "cleaners", "jobs"]) expect(by(table), table).toBe("anonymize");
    for (const table of ["applicants", "members", "evidence", "chatMessages", "inboundMessages"]) expect(by(table), table).toBe("delete");
  });
});

describe("starting a deletion", () => {
  it("needs the destructive capability, this company's request and the company's name typed exactly", async () => {
    const t = start();
    const a = await seeded(t, "owner-a", "Alpha Cleaning");
    const requestId = await requested(a, t);
    await staffWith(t, PLAIN_ADMIN, []);
    await staffWith(t, DESTROYER, ["records.destroy"]);
    expect(await refusal(t.withIdentity(PLAIN_ADMIN).mutation(api.companyDeletion.start, { requestId, confirmName: "Alpha Cleaning" }))).toBe(NOT_ALLOWED);
    expect(await refusal(a.as.mutation(api.companyDeletion.start, { requestId, confirmName: "Alpha Cleaning" }))).toBe("Not found.");
    const staff = t.withIdentity(DESTROYER);
    expect(await refusal(staff.mutation(api.companyDeletion.start, { requestId, confirmName: "alpha cleaning" }))).toMatch(/Type the company's name/);
    // A request that is not a company deletion can never start one.
    const other = await t.run((ctx) => ctx.db.insert("trustRequests", { reference: "SR-OTHER-1", kind: "privacy", subtype: "access", requester: { email: "x@example.com", relationship: "other" }, details: "x", receivedAt: 1, status: "received", routing: "selestial", companyId: a.companyId, verification: {}, notes: [], actions: [], notify: { state: "not_configured", attempts: 0 } }));
    expect(await refusal(staff.mutation(api.companyDeletion.start, { requestId: other, confirmName: "Alpha Cleaning" }))).toMatch(/not a request to delete a company/);
    expect(await countOf(t, "customers", a.companyId)).toBe(12);
  });

  it("is blocked by an active plan, a texting number and money in flight; only money can be waived, by an admin with a reason", async () => {
    const t = start();
    const a = await seeded(t, "owner-a", "Alpha Cleaning");
    const requestId = await requested(a, t);
    await staffWith(t, DESTROYER, ["records.destroy"]);
    const staff = t.withIdentity(DESTROYER);
    await t.run(async (ctx) => {
      await ctx.db.patch(a.companyId, { plan: "operate" });
      await ctx.db.insert("textingRequests", { companyId: a.companyId, status: "active", phoneNumber: "+15125559999", brand: { displayName: "A", companyName: "A", phone: "+1", street: "s", city: "c", state: "TX", postalCode: "1", email: "e@x.com", website: "w", vertical: "v" }, consentWording: "ok", requestedBy: a.ownerId, requestedAt: 1 } as never);
      await ctx.db.insert("payments", { companyId: a.companyId, invoiceId: a.invoiceId, customerId: a.visit.customerId, amountCents: 100, method: "card", source: "stripe", status: "processing", clientKey: "inflight", refundedCents: 0, createdAt: 1, updatedAt: 1 });
    });
    const view = await staff.query(api.companyDeletion.forRequest, { requestId });
    expect(view!.preconditions.filter((row) => row.state === "blocking").map((row) => row.key).sort()).toEqual(["payments", "plan", "texting"]);
    expect(view!.preconditions.find((row) => row.key === "connections")!.state).toBe("by_run");
    expect(view!.canStart).toBe(false);
    expect(await refusal(staff.mutation(api.companyDeletion.start, { requestId, confirmName: "Alpha Cleaning" }))).toMatch(/^Not yet: no active paid plan/);

    await t.run(async (ctx) => {
      await ctx.db.patch(a.companyId, { plan: undefined });
      const number = (await ctx.db.query("textingRequests").withIndex("by_company_requested", (q) => q.eq("companyId", a.companyId)).first())!;
      await ctx.db.patch(number._id, { status: "released" });
    });
    expect(await refusal(staff.mutation(api.companyDeletion.waive, { requestId, key: "payments", reason: "short" }))).toMatch(/Say why/);
    await staff.mutation(api.companyDeletion.waive, { requestId, key: "payments", reason: "Stripe confirms the payment was abandoned by the customer." });
    const after = await staff.query(api.companyDeletion.forRequest, { requestId });
    expect(after!.preconditions.find((row) => row.key === "payments")!.state).toBe("waived");
    expect(after!.canStart).toBe(true);
  });
});

describe("the deletion run", () => {
  it("deletes, anonymizes and keeps as classified across batches, deletes files, and leaves another company alone", async () => {
    const t = start();
    const a = await seeded(t, "owner-a", "Alpha Cleaning");
    const b = await seeded(t, "owner-b", "Beta Cleaning");
    const before = { customers: await countOf(t, "customers", b.companyId), messages: await countOf(t, "messages", b.companyId), evidence: await countOf(t, "evidence", b.companyId), events: await countOf(t, "events", b.companyId) };
    const requestId = await requested(a, t);
    // Setting the company up sent messages of its own (invitations, notices): they are sending records too.
    const messageCount = await countOf(t, "messages", a.companyId);
    expect(messageCount).toBeGreaterThanOrEqual(12);
    await staffWith(t, DESTROYER, ["records.destroy"]);
    const staff = t.withIdentity(DESTROYER);
    const { deletionId } = await staff.mutation(api.companyDeletion.start, { requestId, confirmName: "Alpha Cleaning" });
    await setBatch(t, deletionId, 5);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const done = await t.run(async (ctx) => ctx.db.get(deletionId));
    expect(done!.status).toBe("completed");
    const row = (table: string) => done!.tables.find((entry) => entry.table === table)!;
    expect(row("evidence")).toMatchObject({ deleted: 7, files: 7, done: true });
    expect(row("customers")).toMatchObject({ anonymized: 12, deleted: 0 });
    expect(row("messages")).toMatchObject({ retained: messageCount });
    expect(row("suppressions")).toMatchObject({ retained: 6 });
    expect(done!.disconnected).toEqual({ google: 1, inboxes: 0, connectors: 0 });

    await t.run(async (ctx) => {
      // Files are gone from storage.
      for (const file of a.files) expect(await ctx.storage.get(file)).toBeNull();
      expect(await ctx.db.query("evidence").withIndex("by_company_job", (q) => q.eq("companyId", a.companyId)).collect()).toEqual([]);
      // Customers: the row stays as an anchor, nothing personal in it.
      const customer = (await ctx.db.get(a.visit.customerId))!;
      expect(customer.name).toBe(PLACEHOLDER);
      expect(customer.email).toBeUndefined();
      expect(customer.phone).toBeUndefined();
      // Messages: the sending record stays without its words; the address only as a hash.
      const messages = (await ctx.db.query("messages").withIndex("by_company_queued", (q) => q.eq("companyId", a.companyId)).collect());
      expect(messages).toHaveLength(messageCount);
      for (const message of messages) {
        expect(message.body).toBe(PLACEHOLDER);
        expect(message.to === undefined || message.to.startsWith("sha256:")).toBe(true);
      }
      expect(messages.filter((message) => message.to === addressHash(PHONE))).toHaveLength(12);
      // Opt-outs: kept, address hashed, note gone.
      for (const row of await ctx.db.query("suppressions").withIndex("by_company_at", (q) => q.eq("companyId", a.companyId)).collect()) {
        expect(row.address).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(row.note).toBeUndefined();
      }
      // The consent record keeps the recipient as hashes worked out before the customer was anonymized.
      const permission = (await ctx.db.query("contactPermissions").withIndex("by_company_recipient", (q) => q.eq("companyId", a.companyId)).first())!;
      expect(permission.evidence).toContain(addressHash(PHONE));
      expect(permission.evidence).not.toContain("Elm");
      // Money: amounts stay, descriptions go.
      const invoice = (await ctx.db.get(a.invoiceId))!;
      expect(invoice.totals.totalCents).toBe(16000);
      expect(invoice.lines[0]).toMatchObject({ description: PLACEHOLDER, amountCents: 16000 });
      expect(invoice.memo).toBeUndefined();
      expect(await ctx.db.query("payments").withIndex("by_company_invoice", (q) => q.eq("companyId", a.companyId)).collect()).toHaveLength(1);
      // Connections: disconnected first, credentials gone, connection rows deleted.
      expect((await ctx.db.query("googleCredentials").collect()).filter((row) => row.companyId === a.companyId)).toEqual([]);
      expect(await ctx.db.query("googleConnections").withIndex("by_company", (q) => q.eq("companyId", a.companyId)).collect()).toEqual([]);
      // Memberships gone; the company is a tombstone.
      expect(await ctx.db.query("members").withIndex("by_company", (q) => q.eq("companyId", a.companyId)).collect()).toEqual([]);
      const tomb = (await ctx.db.get(a.companyId))!;
      expect(tomb.name).toBe(DELETED_COMPANY);
      expect(tomb.deletedAt).toBeDefined();
      // Kept events lose their text; operational events are gone; one audit event names the staff member.
      const events = await ctx.db.query("events").withIndex("by_company_at", (q) => q.eq("companyId", a.companyId)).collect();
      expect(events.every((event) => /^(message|company|billing|consent|export|invoice|payment)\./.test(event.type))).toBe(true);
      const sent = events.filter((event) => event.type === "message.sent");
      expect(sent).toHaveLength(6);
      expect(sent[0].data).toMatchObject({ note: PLACEHOLDER, code: "sms" });
      const audit = events.filter((event) => event.type === "company.deleted");
      expect(audit).toHaveLength(1);
      const staffRow = (await ctx.db.query("staff").collect()).find((row) => row.email === DESTROYER.email)!;
      expect(audit[0].data).toMatchObject({ staffId: staffRow._id });
      // The request is completed with the summary.
      const request = (await ctx.db.get(requestId))!;
      expect(request.status).toBe("completed");
      expect(request.completion!.outcome).toMatch(/sign-in accounts were not deleted/);
    });

    // The other company is untouched.
    expect(await countOf(t, "customers", b.companyId)).toBe(before.customers);
    expect(await countOf(t, "messages", b.companyId)).toBe(before.messages);
    expect(await countOf(t, "evidence", b.companyId)).toBe(before.evidence);
    expect(await countOf(t, "events", b.companyId)).toBe(before.events);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(b.visit.customerId))!.email).toBe(EMAIL);
      for (const file of b.files) expect(await ctx.storage.get(file)).not.toBeNull();
      expect((await ctx.db.get(b.companyId))!.name).toBe("Beta Cleaning");
    });
    expect((await b.as.query(api.companies.get, { companyId: b.companyId })).name).toBe("Beta Cleaning");
  });

  it("survives an interruption and resumes without doing anything twice", async () => {
    const t = start();
    const a = await seeded(t, "owner-a", "Alpha Cleaning");
    const requestId = await requested(a, t);
    await staffWith(t, DESTROYER, ["records.destroy"]);
    const { deletionId } = await t.withIdentity(DESTROYER).mutation(api.companyDeletion.start, { requestId, confirmName: "Alpha Cleaning" });
    await setBatch(t, deletionId, 5);
    const messageCount = await countOf(t, "messages", a.companyId);
    // A run takes the lease and does part of the work, then dies (no hand-over, lease still held).
    const token = "crashed-run";
    expect(await t.mutation(internal.companyDeletion.claim, { deletionId, token })).toBe(true);
    for (let i = 0; i < 60; i += 1) await t.mutation(internal.companyDeletion.batch, { deletionId, token });
    const partway = (await t.run((ctx) => ctx.db.get(deletionId)))!;
    expect(partway.status).toBe("running");
    expect(partway.phase).toBe("tables");
    expect(partway.tables.find((row) => row.table === "messages")!.retained).toBe(messageCount);
    // The scheduled run cannot take over while the dead run's lease holds; once it lapses it continues.
    vi.advanceTimersByTime(10 * 60_000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const done = (await t.run((ctx) => ctx.db.get(deletionId)))!;
    expect(done.status).toBe("completed");
    const row = (table: string) => done.tables.find((entry) => entry.table === table)!;
    expect(row("messages").retained).toBe(messageCount);
    expect(row("customers").anonymized).toBe(12);
    expect(row("suppressions").retained).toBe(6);
    expect(row("evidence")).toMatchObject({ deleted: 7, files: 7 });
    expect(row("jobs").anonymized).toBe(a.jobs.length);
    // The dead run's token does nothing any more.
    expect(await t.mutation(internal.companyDeletion.batch, { deletionId, token })).toBe("stopped");
  });

  it("records a failure, stops after its attempts, and resumes from where it stopped", async () => {
    const t = start();
    const a = await seeded(t, "owner-a", "Alpha Cleaning");
    const requestId = await requested(a, t);
    await staffWith(t, DESTROYER, ["records.destroy"]);
    const staff = t.withIdentity(DESTROYER);
    const { deletionId } = await staff.mutation(api.companyDeletion.start, { requestId, confirmName: "Alpha Cleaning" });
    for (let i = 0; i < 5; i += 1) {
      const token = `t${i}`;
      await t.mutation(internal.companyDeletion.claim, { deletionId, token });
      await t.mutation(internal.companyDeletion.failed, { deletionId, token, message: "boom" });
    }
    expect((await t.run((ctx) => ctx.db.get(deletionId)))!.status).toBe("failed");
    await t.mutation(internal.operations.runCheck, { check: "company_deletion" });
    const incidents = await t.run((ctx) => ctx.db.query("incidents").collect());
    expect(incidents.some((row) => row.kind === "company_deletion_failed" && row.state === "needs_staff")).toBe(true);
    await staff.mutation(api.companyDeletion.resume, { requestId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run((ctx) => ctx.db.get(deletionId)))!.status).toBe("completed");
  });
});

describe("while a company is closing", () => {
  it("refuses its members, its support sessions' writes and its links, and tells the Owner where it stands", async () => {
    const t = start();
    const a = await seeded(t, "owner-a", "Alpha Cleaning");
    const requestId = await requested(a, t);
    expect(await a.as.query(api.companyDeletion.status, { companyId: a.companyId })).toMatchObject({ state: "received", dueOn: expect.any(String) });
    const token = await withLinkSecret(() =>
      t.run(async (ctx) => {
        const assignment = (await ctx.db.query("assignments").withIndex("by_company_job", (q) => q.eq("companyId", a.companyId)).first())!;
        const id = await ctx.db.insert("actionLinks", { companyId: a.companyId, publicId: "LINK-ALPHA-CLOSING", purpose: "offer", cleanerId: a.visit.cleanerId, jobId: a.visit.jobId, assignmentId: assignment._id, allowed: ["accept"], expiresAt: Date.now() + DAY, issuedAt: Date.now() });
        return tokenFor((await ctx.db.get(id))!);
      }),
    );
    await staffWith(t, DESTROYER, ["records.destroy"]);
    await t.withIdentity(DESTROYER).mutation(api.companyDeletion.start, { requestId, confirmName: "Alpha Cleaning" });

    const company = (await t.run((ctx) => ctx.db.get(a.companyId)))!;
    expect(company.closingAt).toBeDefined();
    expect(company.suspendedAt).toBeDefined();
    expect(company.pausedAgents.sort()).toEqual(["dispatch", "quality", "recruiter", "retention", "sales"]);
    // Members: nothing reads or writes, not even what a locked account still allows.
    expect(await refusal(a.as.query(api.companies.get, { companyId: a.companyId }))).toMatch(/being deleted/);
    expect(await refusal(a.as.mutation(api.customers.create, { companyId: a.companyId, name: "New", kind: "home" }))).toMatch(/being deleted/);
    expect(await refusal(a.as.mutation(api.dataRights.requestExport, { companyId: a.companyId }))).toMatch(/being deleted/);
    // Links: no longer available.
    expect(await refusal(withLinkSecret(() => t.query(api.links.offer, { token: token! })))).toBe("This page is no longer available.");
    // The Owner's own status still answers, and the app knows to show it.
    expect(await a.as.query(api.companyDeletion.status, { companyId: a.companyId })).toMatchObject({ state: "in_progress" });
    expect((await a.as.query(api.companies.mine, {}))[0]).toMatchObject({ closing: true });
    // Sending: the check every message passes refuses everything, from a person or an agent.
    const answer = await t.run((ctx) => checkSend(ctx, { companyId: a.companyId, channel: "sms", to: PHONE, category: "operational", origin: "member", now: Date.now() } as never));
    expect(answer).toMatchObject({ ok: false, code: "company_suspended" });
  });
});

describe("the deletion clock", () => {
  it("opens a deletion request when a plan is cancelled for non-payment, and deletes nothing", async () => {
    const t = start();
    const a = await seeded(t, "owner-a", "Alpha Cleaning");
    const rowId = await t.run((ctx) =>
      ctx.db.insert("billingDunning", { companyId: a.companyId, env: "sandbox", invoiceId: "in_1", attempts: 2, amountCents: 9900, currency: "usd", hostedUrl: null, firstFailedAt: 1, lastFailedAt: 1, nextAttemptAt: null, lockedAt: 1, events: [], updatedAt: 1 }),
    );
    await t.mutation(internal.billingLock.canceled, { rowId });
    const requests = await t.run((ctx) => ctx.db.query("trustRequests").withIndex("by_company_received", (q) => q.eq("companyId", a.companyId)).collect());
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: "privacy", subtype: "deletion", status: "received", dueOn: new Date(Date.now() + 90 * DAY).toISOString().slice(0, 10) });
    expect(requests[0].notes.map((row) => row.text)).toEqual(["plan cancelled for non-payment"]);
    // Nothing was deleted and nothing started.
    expect(await countOf(t, "customers", a.companyId)).toBe(12);
    expect(await countOf(t, "members", a.companyId)).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(a.companyId)))!.closingAt).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("companyDeletions").collect())).toEqual([]);
    // A second cancellation does not open a second request.
    const second = await t.run((ctx) => ctx.db.insert("billingDunning", { companyId: a.companyId, env: "sandbox", invoiceId: "in_2", attempts: 2, amountCents: 9900, currency: "usd", hostedUrl: null, firstFailedAt: 1, lastFailedAt: 1, nextAttemptAt: null, lockedAt: 1, events: [], updatedAt: 1 }));
    await t.mutation(internal.billingLock.canceled, { rowId: second });
    expect(await t.run((ctx) => ctx.db.query("trustRequests").withIndex("by_company_received", (q) => q.eq("companyId", a.companyId)).collect())).toHaveLength(1);
  });

  it("raises a staff incident when a deletion request is within 14 days of its due date", async () => {
    const t = start();
    const a = await company(t, "owner-a", "Alpha Cleaning");
    const requestId = await requested(a, t);
    await t.mutation(internal.operations.runCheck, { check: "company_deletion" });
    expect((await t.run((ctx) => ctx.db.query("incidents").collect())).filter((row) => row.kind === "company_deletion_due")).toEqual([]);
    await t.run((ctx) => ctx.db.patch(requestId, { dueOn: new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10) }));
    await t.mutation(internal.operations.runCheck, { check: "company_deletion" });
    const due = (await t.run((ctx) => ctx.db.query("incidents").collect())).filter((row) => row.kind === "company_deletion_due");
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ severity: "high", state: "needs_staff", companyId: a.companyId });
  });
});
