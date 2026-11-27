/**
 * "Build my workspace", end to end: the Owner chooses an outcome, confirms essentials and presses Build
 * once; configuration and activation run in the background with no page open; the one progress picture
 * counts each item once and truthfully; nothing is published, sent or charged. Then the hard cases:
 * pressing Build again, a part that fails and is retried, the owner's own price, early exit, handoffs to
 * other pages, staff, and an existing company's permissions.
 *
 * @vitest-environment edge-runtime
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, refusal, start, type T } from "../tests/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { NOT_ALLOWED } from "./lib/errors";
import { recordEvent } from "./lib/events";
import type { Priority } from "./lib/setup/schema";

type As = Awaited<ReturnType<typeof company>>["as"];

async function drain(t: T, rounds = 30, stepMs = 20_000) {
  for (let i = 0; i < rounds; i += 1) {
    vi.advanceTimersByTime(stepMs);
    await t.finishInProgressScheduledFunctions();
  }
}

/** Setup as an owner fills it: one outcome, the essentials, and what the context step asks. */
async function essentials(as: As, companyId: Id<"companies">, priority: Priority, answers: Record<string, string | string[]> = {}, facts: Record<string, string | string[]> = {}) {
  let { revision } = await as.mutation(api.setup.save, { companyId, expectedRevision: 0, step: "essentials", priority, secondary: [] });
  ({ revision } = await as.mutation(api.setup.save, { companyId, expectedRevision: revision, step: "context", methods: ["manual"], company: { timezone: "America/Chicago" }, facts: { "company.location": "Austin, TX", "services.categories": ["residential"], ...facts } }));
  if (Object.keys(answers).length) ({ revision } = await as.mutation(api.setup.save, { companyId, expectedRevision: revision, step: "context", answers }));
  return revision;
}

const of = <R extends { companyId: Id<"companies"> }>(rows: R[], companyId: Id<"companies">) => rows.filter((row) => row.companyId === companyId);
const counts = (t: T, companyId: Id<"companies">) =>
  t.run(async (ctx) => ({
    services: of(await ctx.db.query("services").collect(), companyId).length,
    forms: of(await ctx.db.query("bookingExperiences").collect(), companyId).length,
    roles: of(await ctx.db.query("hiringNeeds").collect(), companyId).length,
    agreements: of(await ctx.db.query("agreements").collect(), companyId).length,
    activations: of(await ctx.db.query("activations").collect(), companyId).length,
    // Anything addressed to a customer, applicant or cleaner. Notices to the company's own people are separate.
    outbound: of(await ctx.db.query("messages").collect(), companyId).filter((row) => row.purpose !== "member_notice").length,
  }));

describe("Build my workspace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prepares a Sales outcome once, leads with the booking form, counts truthfully and sends nothing", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await essentials(as, companyId, "sales", { "pricing.path": "later", "inquiries.channels": ["phone"] }, { "company.areas": "Austin and Round Rock" });

    // Before Build: one sentence of what it will prepare, and no lead that has nothing behind it.
    const preview = (await as.query(api.setup.buildStatus, { companyId }))!;
    expect(preview).toMatchObject({ started: false, outcome: "sales", configure: ["services", "booking"] });
    if (preview.started) throw new Error("not started yet");
    expect(preview.sentence).toBe("We'll prepare your service drafts, a booking form preview, and your first Sales setup using the details you confirmed.");
    // A new account has no leads: Sales doesn't plan to follow through on inquiries that don't exist.
    expect(preview.tasks.map((task) => task.template)).not.toContain("sales.inquiry_follow_through");
    // Configuration makes the service and booking drafts, so activation doesn't make them a second time.
    expect(preview.tasks.map((task) => task.template)).not.toContain("sales.service_draft");
    expect(preview.tasks.map((task) => task.template)).not.toContain("sales.booking_page");

    const first = await as.mutation(api.setup.build, { companyId });
    expect(first.queued).toEqual(["services", "booking"]);
    // Build doesn't open the workspace: the owner reviews their first result in setup.
    expect((await as.query(api.setup.state, { companyId })).setup).toMatchObject({ status: "in_progress", step: "result" });
    let status = (await as.query(api.setup.buildStatus, { companyId }))!;
    if (!status.started) throw new Error("expected started");
    expect(status.counts.preparing).toBeGreaterThan(0);
    expect(status.counts.usable).toBe(0);

    await drain(t);
    status = (await as.query(api.setup.buildStatus, { companyId }))!;
    if (!status.started) throw new Error("expected started");
    expect(status.lead?.key).toBe("configure:booking");
    expect(status.headline).toBe("Your booking form draft is ready");
    expect(status.counts).toMatchObject({ preparing: 0, failed: 0, published: 0 });
    expect(status.counts.usable).toBe(status.counts.ready);
    expect(status.counts.total).toBe(status.counts.ready + status.counts.needsInput + status.counts.waitingConnection + status.counts.failed + status.counts.published + status.counts.preparing + status.counts.notAvailable + [status.lead, ...status.rest].filter((item) => item?.state === "done").length);
    // Prices were left for later: the booking form asks for estimates, never instant booking.
    const form = await t.run(async (ctx) => of(await ctx.db.query("bookingExperiences").collect(), companyId)[0]);
    expect(form.draft.behavior.mode).toBe("estimate_request");
    expect(form.status).toBe("draft");

    const before = await counts(t, companyId);
    expect(before.outbound).toBe(0);
    expect(before.forms).toBe(1);
    // Pressing Build again, as a refresh or a second tab would: nothing is prepared twice.
    const again = await as.mutation(api.setup.build, { companyId });
    expect(again.queued).toEqual([]);
    expect(again.activation).toBe("already");
    await drain(t);
    expect(await counts(t, companyId)).toEqual(before);
    // No permission changed, and the milestones are the real times.
    expect((await as.query(api.permissions.list, { companyId })).actions.filter((row) => row.changed)).toEqual([]);
    const setup = await t.run(async (ctx) => of(await ctx.db.query("companySetups").collect(), companyId)[0]);
    expect(setup.milestones.buildStartedAt).toBeTypeOf("number");
    expect(setup.milestones.firstUsableAt).toBeGreaterThanOrEqual(setup.milestones.buildStartedAt!);
    // The owner is told the outcome, not every draft as it lands.
    const notices = await t.run(async (ctx) => of(await ctx.db.query("memberNotices").collect(), companyId));
    expect(notices.filter((row) => row.kind === "task_completed")).toEqual([]);
    // Each notice once per person, however many times the work was reported or Build was pressed.
    expect(new Set(notices.map((row) => row.dedupeKey)).size).toBe(notices.length);
  });

  it("gives every outcome a first result made from real records, and says exactly what is missing", async () => {
    const t = start();
    const expected: Record<Priority, { lead: string; state?: string }> = {
      sales: { lead: "configure:booking" },
      pricing: { lead: "configure:services" },
      booking: { lead: "configure:booking" },
      recruiter: { lead: "activation:recruiter.role_draft", state: "ready" },
      // No upcoming jobs: the dispatch setup leads, and the coverage review waits, saying what starts it.
      dispatch: { lead: "activation:dispatch.readiness", state: "ready" },
      // No customers: the follow-up setup leads, and the review says what it needs.
      retention: { lead: "activation:retention.care_setup" },
    };
    const answers: Record<Priority, Record<string, string | string[]>> = {
      sales: { "pricing.path": "assist", "inquiries.channels": ["email"] },
      pricing: { "pricing.path": "assist" },
      booking: { "pricing.path": "later" },
      recruiter: { "hiring.now": "now" },
      dispatch: { "jobs.where": "none_yet" },
      retention: { "customers.where": "few" },
    };
    for (const [index, outcome] of (Object.keys(expected) as Priority[]).entries()) {
      const { as, companyId } = await company(t, `owner-${index}`, `Company ${index}`);
      await essentials(as, companyId, outcome, answers[outcome], outcome === "recruiter" ? { "workforce.arrangement": ["employees"] } : {});
      await as.mutation(api.setup.build, { companyId });
      await drain(t);
      const status = (await as.query(api.setup.buildStatus, { companyId }))!;
      if (!status.started) throw new Error(`${outcome}: expected started`);
      expect(status.lead?.key, outcome).toBe(expected[outcome].lead);
      if (expected[outcome].state) expect(status.lead?.state, outcome).toBe(expected[outcome].state);
      if (status.lead?.state === "needs_input") expect(status.lead.action, outcome).not.toBeNull();
      // Each item appears once.
      const keys = [status.lead, ...status.rest].filter(Boolean).map((item) => item!.key);
      expect(new Set(keys).size, outcome).toBe(keys.length);
      // Waiting work says exactly what it needs; nothing is invented to fill it.
      if (outcome === "dispatch" || outcome === "retention") {
        const review = status.rest.find((item) => item.key === (outcome === "dispatch" ? "activation:dispatch.coverage_review" : "activation:retention.review"))!;
        expect(review.state, outcome).toBe("needs_input");
        expect(review.words, outcome).toMatch(outcome === "dispatch" ? /no upcoming visits/i : /no customers or past visits/i);
        expect(review.outputs, outcome).toEqual([]);
      }
      const made = await counts(t, companyId);
      expect(made.outbound, outcome).toBe(0);
      // The inbox isn't read for a recruiter who didn't say applicants email them.
      if (outcome === "recruiter") {
        expect(keys).not.toContain("activation:recruiter.applicant_review");
        expect(made.roles).toBe(1);
        const role = await t.run(async (ctx) => of(await ctx.db.query("hiringNeeds").collect(), companyId)[0]);
        expect(role.status).toBe("draft");
      }
    }
  });

  it("counts a failed part as failed, keeps the rest usable, and retries only that part", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await essentials(as, companyId, "sales", { "pricing.path": "later", "inquiries.channels": ["phone"] }, { "company.areas": "Austin" });
    await as.mutation(api.setup.build, { companyId });
    await drain(t);
    // The services build ends up failed (as after three failed tries).
    await t.run(async (ctx) => {
      const row = of(await ctx.db.query("configOutputs").collect(), companyId).find((r) => r.kind === "services")!;
      await ctx.db.patch(row._id, { state: "failed", lastError: "The template could not be read." });
    });
    let status = (await as.query(api.setup.buildStatus, { companyId }))!;
    if (!status.started) throw new Error("expected started");
    const services = [status.lead, ...status.rest].find((item) => item?.key === "configure:services")!;
    expect(services.state).toBe("failed");
    expect(services.retry).toEqual({ kind: "configure", outputKind: "services" });
    expect(status.counts.failed).toBe(1);
    // A failure is never counted as prepared, and it doesn't hide the booking form that is ready.
    expect(status.counts.usable).toBeLessThanOrEqual(status.counts.ready + status.counts.published);
    expect([status.lead, ...status.rest].filter((item) => item && item.state === "failed").every((item) => item!.outputs.length === 0 || !["ready", "published"].includes(item!.state))).toBe(true);
    expect(status.lead?.key).toBe("configure:booking");
    const before = await counts(t, companyId);

    await as.mutation(api.setup.retryBuildItem, { companyId, configureKind: "services" });
    await drain(t);
    status = (await as.query(api.setup.buildStatus, { companyId }))!;
    if (!status.started) throw new Error("expected started");
    expect(status.counts.failed).toBe(0);
    // The retry adopted the drafts it made before: no duplicates.
    expect((await counts(t, companyId)).services).toBe(before.services);
    expect(await refusal(as.mutation(api.setup.retryBuildItem, { companyId, configureKind: "agreements" }))).toContain("isn't part of your workspace build");
    const types = await t.run(async (ctx) => of(await ctx.db.query("events").collect(), companyId).map((row) => row.type));
    expect(types).toContain("setup.build_retried");
  });

  it("adds a later priority's own work to the same batch, while it runs or after it settles, and redoes nothing", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await essentials(as, companyId, "sales", { "pricing.path": "later", "inquiries.channels": ["phone"] }, { "company.areas": "Austin", "workforce.arrangement": ["employees"] });
    const first = await as.mutation(api.setup.build, { companyId });
    // While it is still running: Recruiter is added to the same batch.
    let revision = (await as.query(api.setup.state, { companyId })).setup!.revision;
    await as.mutation(api.setup.save, { companyId, expectedRevision: revision, step: "result", secondary: ["recruiter"] });
    const extended = await as.mutation(api.setup.build, { companyId });
    expect(extended).toMatchObject({ activation: "extended", activationId: first.activationId });
    await drain(t);
    let status = (await as.query(api.setup.buildStatus, { companyId }))!;
    if (!status.started) throw new Error("expected started");
    expect(status.included).toEqual(["recruiter"]);
    expect([status.lead, ...status.rest].map((item) => item?.key)).toContain("activation:recruiter.role_draft");
    const before = await counts(t, companyId);
    expect(before).toMatchObject({ activations: 1, roles: 1, forms: 1 });

    // After it settled: retention is added, again to the same batch; nothing already made is made twice.
    revision = (await as.query(api.setup.state, { companyId })).setup!.revision;
    await as.mutation(api.setup.save, { companyId, expectedRevision: revision, step: "result", secondary: ["recruiter", "retention"] });
    expect((await as.mutation(api.setup.build, { companyId })).activation).toBe("extended");
    await drain(t);
    status = (await as.query(api.setup.buildStatus, { companyId }))!;
    if (!status.started) throw new Error("expected started");
    expect(status.included).toEqual(["recruiter", "retention"]);
    expect(await counts(t, companyId)).toMatchObject({ activations: 1, roles: 1, forms: 1, services: before.services, outbound: 0 });
    // Pressing it once more adds nothing.
    expect((await as.mutation(api.setup.build, { companyId })).activation).toBe("already");
    const tasks = await t.run(async (ctx) => of(await ctx.db.query("activationTasks").collect(), companyId).map((row) => row.template));
    expect(new Set(tasks).size).toBe(tasks.length);
  });

  it("keeps the owner's own price exactly as entered, as a draft", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await essentials(as, companyId, "pricing", { "pricing.path": "existing" });
    const first = await as.mutation(api.setup.saveFirstService, { companyId, name: "Standard home clean", priceCents: 15000 });
    expect(first.created).toBe(true);
    // Saving again updates the same draft.
    expect((await as.mutation(api.setup.saveFirstService, { companyId, name: "Standard home clean", priceCents: 16500 })).created).toBe(false);
    expect(await refusal(as.mutation(api.setup.saveFirstService, { companyId, name: "Free", priceCents: 0 }))).toContain("at least $1");
    await as.mutation(api.setup.build, { companyId });
    await drain(t);
    const draft = await t.run(async (ctx) => (await ctx.db.query("serviceDrafts").collect()).find((row) => row.serviceId === first.serviceId)!);
    expect(draft.spec.pricing).toMatchObject({ method: "fixed", amountCents: 16500 });
    expect(draft.spec.illustrative).toBe(false);
    const service = await t.run(async (ctx) => ctx.db.get(first.serviceId));
    expect(service!.status).toBe("draft");
    // Configuration kept it as the owner's, and made no second copy from the same starting point.
    const fromTemplate = await t.run(async (ctx) => of(await ctx.db.query("services").collect(), companyId).filter((row) => row.templateId === service!.templateId));
    expect(fromTemplate).toHaveLength(1);
  });

  it("lets the owner leave early with preparation still running, records handoffs safely, and keeps staff out", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await essentials(as, companyId, "recruiter", { "hiring.now": "now" }, { "workforce.arrangement": ["contractors"] });
    await as.mutation(api.setup.build, { companyId });
    // Save and exit before the work ran: the workspace opens, and the work carries on without a page.
    await as.mutation(api.setup.exit, { companyId });
    expect((await as.query(api.setup.state, { companyId })).setup).toMatchObject({ status: "entered" });
    await drain(t);
    const status = (await as.query(api.setup.buildStatus, { companyId }))!;
    if (!status.started) throw new Error("expected started");
    expect(status.lead).toMatchObject({ key: "activation:recruiter.role_draft", state: "ready" });
    // Coming back is recorded once per time they left.
    await as.mutation(api.setup.resume, { companyId });
    await as.mutation(api.setup.resume, { companyId });

    // Handoffs: only pages setup allows, never another site.
    for (const href of ["https://evil.example/app/setup", "//evil.example", "/app/settings/../../evil", "/app/chat", "/\\evil.example"]) expect(await refusal(as.mutation(api.setup.handoff, { companyId, href, phase: "started" }))).toContain("isn't part of setup");
    await as.mutation(api.setup.handoff, { companyId, href: "/app/agents/recruiter/applicants", phase: "started" });
    await as.mutation(api.setup.handoff, { companyId, href: "/app/settings/integrations?tool=gmail&result=failed", phase: "failed" });
    const setup = await t.run(async (ctx) => of(await ctx.db.query("companySetups").collect(), companyId)[0]);
    expect(setup.handoff).toMatchObject({ kind: "inbox", href: "/app/agents/recruiter/applicants", step: "result", outcome: "failed" });
    // A connection that really lands closes the handoff as completed, once; a page visit alone never does.
    await as.mutation(api.setup.handoff, { companyId, href: "/app/settings/integrations", phase: "started" });
    for (let i = 0; i < 2; i += 1) await t.run((ctx) => recordEvent(ctx, { companyId, type: "google.connected", actor: { kind: "system" }, subject: { table: "companies", id: companyId } }));
    expect((await t.run(async (ctx) => of(await ctx.db.query("companySetups").collect(), companyId)[0])).handoff).toMatchObject({ kind: "integration", outcome: "completed" });
    const types = await t.run(async (ctx) => of(await ctx.db.query("events").collect(), companyId).map((row) => row.type));
    expect(types.filter((type) => type === "setup.handoff_completed")).toHaveLength(1);
    expect(types.filter((type) => type === "setup.resumed")).toHaveLength(1);
    expect(types).toEqual(expect.arrayContaining(["setup.exited", "setup.handoff_started", "setup.handoff_failed"]));
    // Analytics carry no customer content: event data is only counts, ids of stages and paths.
    const data = await t.run(async (ctx) => of(await ctx.db.query("events").collect(), companyId).filter((row) => row.type.startsWith("setup.")).map((row) => JSON.stringify(row.data ?? {})));
    expect(data.join(" ")).not.toMatch(/Alpha Cleaning|Austin/);

    // Invited staff never go through setup and can't build or hand off.
    const manager = await addMember(t, as, companyId, "manager-a", "manager");
    expect(await manager.query(api.setup.state, { companyId })).toMatchObject({ required: false, canEdit: false });
    expect(await refusal(manager.mutation(api.setup.build, { companyId }))).toBe(NOT_ALLOWED);
    expect(await refusal(manager.mutation(api.setup.handoff, { companyId, href: "/app/approvals", phase: "started" }))).toBe(NOT_ALLOWED);
    expect(await manager.query(api.setup.questions, { companyId })).toBeNull();
  });

  it("never resets an existing company's permissions or data when it chooses setup later", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await as.mutation(api.permissions.set, { companyId, action: "dispatch.send_reminder", level: "execute" });
    // A company made before setup existed.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("companySetups").collect()) await ctx.db.delete(row._id);
    });
    const levels = async () => (await as.query(api.permissions.list, { companyId })).actions.map((row) => [row.key, row.level]);
    const before = await levels();
    await as.mutation(api.setup.begin, { companyId });
    const revision = (await as.query(api.setup.state, { companyId })).setup!.revision;
    await as.mutation(api.setup.save, { companyId, expectedRevision: revision, step: "essentials", priority: "dispatch" });
    await as.mutation(api.setup.build, { companyId });
    await drain(t);
    expect(await levels()).toEqual(before);
    // It stays a place they visit: never a gate.
    expect(await as.query(api.setup.state, { companyId })).toMatchObject({ required: false });
  });
});
