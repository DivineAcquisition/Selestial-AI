/**
 * Business configuration, end to end: the Owner answers a few questions, presses Prepare and leaves; the
 * background jobs make real drafts in Services & Pricing, Booking forms, Agreements and Quality; nothing is
 * published or sent. Then the hard cases: starting twice, an owner's edit surviving a change of answers,
 * an existing workspace, a kind that keeps failing, an agreement they already have, and other roles.
 *
 * @vitest-environment edge-runtime
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, refusal, start, type T } from "../tests/harness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { NOT_ALLOWED } from "./lib/errors";

type As = Awaited<ReturnType<typeof company>>["as"];

/** Runs the background work as the server would, with time moving forward, and no page open. */
async function drain(t: T, rounds = 12, stepMs = 30_000) {
  for (let i = 0; i < rounds; i += 1) {
    vi.advanceTimersByTime(stepMs);
    await t.finishInProgressScheduledFunctions();
  }
}

async function basics(as: As, companyId: Id<"companies">, categories: string[], answers: Record<string, string> = {}) {
  const { revision } = await as.mutation(api.setup.save, { companyId, expectedRevision: 0, step: "team", methods: ["manual"], facts: { "company.areas": "Austin", "services.categories": categories } });
  if (Object.keys(answers).length) {
    const r = await as.mutation(api.setup.save, { companyId, expectedRevision: revision, step: "priority", priority: "booking", secondary: [] });
    await as.mutation(api.setup.save, { companyId, expectedRevision: r.revision, step: "priority", answers });
  }
}

const COSTS = { pay: { model: "hourly" as const, hourlyCents: 2200, burdenPercent: 10 }, targetMarginPercent: 40, minimumJobCents: 12000, suppliesPerVisitCents: 800 };

const rows = (t: T, companyId: Id<"companies">) => t.run(async (ctx) => (await ctx.db.query("configOutputs").collect()).filter((row) => row.companyId === companyId));
const services = (t: T, companyId: Id<"companies">) => t.run(async (ctx) => (await ctx.db.query("services").collect()).filter((row) => row.companyId === companyId));
const experiences = (t: T, companyId: Id<"companies">) => t.run(async (ctx) => (await ctx.db.query("bookingExperiences").collect()).filter((row) => row.companyId === companyId));
const agreements = (t: T, companyId: Id<"companies">) => t.run(async (ctx) => (await ctx.db.query("agreements").collect()).filter((row) => row.companyId === companyId));
const standards = (t: T, companyId: Id<"companies">) => t.run(async (ctx) => (await ctx.db.query("qualityStandards").collect()).filter((row) => row.companyId === companyId));
const draftOf = (t: T, serviceId: Id<"services">) => t.run(async (ctx) => (await ctx.db.query("serviceDrafts").collect()).find((row) => row.serviceId === serviceId)!);

describe("Business configuration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prepares a residential company's services from its costs, a booking form, agreements and standards, and publishes nothing", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await basics(as, companyId, ["residential"]);

    // The answers go to their own homes: a fact, the pricing profile, business settings.
    let inputs = await as.query(api.configure.inputs, { companyId });
    expect(inputs.preparing).toEqual(["res-standard", "res-deep", "res-move"]);
    await as.mutation(api.configure.saveOffering, { companyId, offered: ["res-standard", "res-deep"] });
    await as.mutation(api.configure.saveCosts, { companyId, ...COSTS });
    await as.mutation(api.configure.saveAvailability, { companyId, serviceAreas: ["78701", "78702"], hours: [{ weekday: 1, startMinute: 480, endMinute: 1020 }] });
    inputs = await as.query(api.configure.inputs, { companyId });
    expect(inputs).toMatchObject({ offered: ["res-standard", "res-deep"], preparing: ["res-standard", "res-deep"], serviceAreas: ["78701", "78702"], costs: { targetMarginPercent: 40, minimumJobCents: 12000 } });
    expect((await as.query(api.services.profile, { companyId })).costs).toMatchObject({ targetMarginPercent: 40, pay: { model: "hourly", hourlyCents: 2200 } });
    // Nothing is prepared until the Owner asks.
    expect(await rows(t, companyId)).toEqual([]);

    expect((await as.mutation(api.configure.start, { companyId })).queued.sort()).toEqual(["agreements", "booking", "services", "standards"]);
    expect((await as.query(api.configure.workspace, { companyId })).cards.find((c) => c.kind === "services")!.status).toBe("preparing");
    await drain(t);

    // Two service drafts, priced from the owner's costs, not published.
    const made = await services(t, companyId);
    expect(made.map((s) => [s.templateId, s.status]).sort()).toEqual([
      ["res-deep", "draft"],
      ["res-standard", "draft"],
    ]);
    for (const s of made) expect((await draftOf(t, s._id)).spec.illustrative).toBe(false);

    // One booking form, a draft offering those two drafts, where customers book a firm price once published.
    const [page] = await experiences(t, companyId);
    expect(page).toMatchObject({ kind: "residential", status: "draft" });
    expect(page.draft.behavior.mode).toBe("instant");
    expect(page.draft.services.offered.map((s) => s.serviceKey).sort()).toEqual(made.map((s) => s.key).sort());

    // Agreements that fit the services, and a standard for each.
    expect((await agreements(t, companyId)).map((a) => [a.docType, a.workflow]).sort()).toEqual([
      ["deep_cleaning", "draft"],
      ["one_time_residential", "draft"],
    ]);
    expect((await standards(t, companyId)).map((s) => s.status)).toEqual(["draft", "draft"]);

    // The review workspace reads each record: ready to review, with the honest reason the form can't take bookings.
    const view = await as.query(api.configure.workspace, { companyId });
    const card = (kind: string) => view.cards.find((c) => c.kind === kind)!;
    expect(card("services")).toMatchObject({ status: "ready", missing: [], changed: false });
    expect(card("services").items[0].detail).toMatch(/\$\d/);
    expect(card("services").notes.join(" ")).toMatch(/not market research/);
    expect(card("booking").items[0].flags[0]).toMatch(/2 of its 2 services aren't published/);
    expect(card("agreements").items.every((i) => i.flags.includes("Starting text: nobody has reviewed these terms"))).toBe(true);
    expect(view.priced).toBe(true);

    // Nothing was sent to anyone.
    // Only the welcome email sent to the Owner when the company was made: nothing went to a customer or cleaner.
    const sent = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.companyId === companyId && m.purpose !== "member_notice"));
    expect(sent).toEqual([]);
  });

  it("asks for a walkthrough for commercial work, keeps template prices marked as examples without costs, and says what's missing", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await basics(as, companyId, ["commercial"]);
    await as.mutation(api.configure.start, { companyId });
    await drain(t);
    const [office] = await services(t, companyId);
    expect(office.templateId).toBe("com-office");
    expect((await draftOf(t, office._id)).spec.illustrative).toBe(true);
    const [page] = await experiences(t, companyId);
    expect(page.draft.behavior.mode).toBe("walkthrough_request");
    const view = await as.query(api.configure.workspace, { companyId });
    const servicesCard = view.cards.find((c) => c.kind === "services")!;
    expect(servicesCard.status).toBe("needs_info");
    expect(servicesCard.missing[0].words).toMatch(/what you pay cleaners and the margin you aim for/);
    const booking = view.cards.find((c) => c.kind === "booking")!;
    expect(booking.missing.map((m) => m.words).join(" ")).toMatch(/ZIP codes.*days and hours/);
    expect((await agreements(t, companyId)).map((a) => a.docType)).toEqual(["office_janitorial"]);
  });

  it("prepares a booking form per kind of page for a mixed company, and asks for estimates when they quote every job", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await basics(as, companyId, ["residential", "short_term_rental"], { "pricing.state": "quote_each" });
    await as.mutation(api.configure.saveCosts, { companyId, ...COSTS });
    await as.mutation(api.configure.start, { companyId });
    await drain(t);
    const pages = await experiences(t, companyId);
    expect(pages.map((p) => [p.kind, p.draft.behavior.mode]).sort()).toEqual([
      ["residential", "estimate_request"],
      ["short_term_rental", "estimate_request"],
    ]);
    expect((await services(t, companyId)).map((s) => s.templateId).sort()).toEqual(["res-deep", "res-move", "res-standard", "str-turnover"]);
  });

  it("starts once, and an owner's edit survives a change of answers while untouched drafts follow it", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await basics(as, companyId, ["residential"]);
    await as.mutation(api.configure.saveOffering, { companyId, offered: ["res-standard", "res-deep"] });
    await as.mutation(api.configure.saveCosts, { companyId, ...COSTS });
    await as.mutation(api.configure.start, { companyId });
    await drain(t);
    // Pressing it again, with nothing changed, prepares nothing new.
    expect((await as.mutation(api.configure.start, { companyId })).queued).toEqual([]);
    await drain(t);
    expect(await services(t, companyId)).toHaveLength(2);
    expect(await experiences(t, companyId)).toHaveLength(1);

    // The owner edits the deep clean draft.
    const deep = (await services(t, companyId)).find((s) => s.templateId === "res-deep")!;
    const standard = (await services(t, companyId)).find((s) => s.templateId === "res-standard")!;
    const deepDraft = await draftOf(t, deep._id);
    await t.run(async (ctx) => ctx.db.patch(deepDraft._id, { spec: { ...deepDraft.spec, summary: "Our own words" }, revision: deepDraft.revision + 1 }));
    const standardBefore = (await draftOf(t, standard._id)).spec;

    // A higher margin: the untouched draft is repriced in place; the edited one is kept.
    await as.mutation(api.configure.saveCosts, { companyId, ...COSTS, targetMarginPercent: 55 });
    await drain(t);
    expect((await draftOf(t, deep._id)).spec.summary).toBe("Our own words");
    const standardAfter = (await draftOf(t, standard._id)).spec;
    expect(JSON.stringify(standardAfter.pricing)).not.toBe(JSON.stringify(standardBefore.pricing));
    expect(await services(t, companyId)).toHaveLength(2);
    const view = await as.query(api.configure.workspace, { companyId });
    const card = view.cards.find((c) => c.kind === "services")!;
    expect(card.kept.map((k) => k.why)).toEqual(["You changed this draft, so it was left as you made it."]);
    expect(card.items.find((i) => i.label === deep.name)!.flags).toContain("You edited this");
    expect(card.changed).toBe(false);
  });

  it("adopts drafts an existing workspace already has, and leaves a live booking form alone", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await basics(as, companyId, ["residential"]);
    const { serviceId } = await as.mutation(api.setup.prepareService, { companyId, templateId: "res-standard" });
    const live = await as.mutation(api.bookingExperiences.create, { companyId, kind: "residential", name: "Book a clean" });
    await t.run(async (ctx) => ctx.db.patch(live as Id<"bookingExperiences">, { status: "published", publishedVersion: 1 }));
    await as.mutation(api.configure.saveOffering, { companyId, offered: ["res-standard"] });
    await as.mutation(api.configure.start, { companyId });
    await drain(t);
    expect((await services(t, companyId)).map((s) => s._id)).toEqual([serviceId]);
    expect(await experiences(t, companyId)).toHaveLength(1);
    const card = (await as.query(api.configure.workspace, { companyId })).cards.find((c) => c.kind === "booking")!;
    expect(card.kept[0].why).toMatch(/already have this booking form live/);
  });

  it("retries a kind that fails, stops after three attempts, and tells the cards that wait on it", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await basics(as, companyId, ["residential"]);
    await as.mutation(api.configure.start, { companyId });
    // The Owner who started it stops being one before the work runs.
    await t.run(async (ctx) => {
      const member = (await ctx.db.query("members").collect()).find((m) => m.companyId === companyId)!;
      await ctx.db.patch(member._id, { role: "manager" });
    });
    await drain(t, 40);
    const byKind = Object.fromEntries((await rows(t, companyId)).map((row) => [row.kind, row]));
    expect(byKind.services).toMatchObject({ state: "failed", attempts: 3 });
    expect(byKind.services.lastError).toMatch(/no longer the Owner/);
    expect(byKind.booking.state).toBe("waiting");
    expect(await services(t, companyId)).toEqual([]);
    // An abandoned worker is picked up by the sweep.
    await t.run(async (ctx) => ctx.db.patch(byKind.standards._id, { state: "working", nextRunAt: Date.now() - 1 }));
    await t.mutation(internal.configure.sweep, {});
    expect((await rows(t, companyId)).find((r) => r.kind === "standards")!.state).toBe("queued");
  });

  it("prepares no agreement when they have their own, and lets only the Owner change any of it", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await basics(as, companyId, ["residential"], { "agreements.have": "own" });
    await as.mutation(api.configure.start, { companyId });
    await drain(t);
    expect(await agreements(t, companyId)).toEqual([]);
    const card = (await as.query(api.configure.workspace, { companyId })).cards.find((c) => c.kind === "agreements")!;
    expect(card.missing[0].words).toMatch(/Upload your own agreement/);

    const manager = await addMember(t, as, companyId, "manager-a", "manager");
    expect(await refusal(manager.mutation(api.configure.start, { companyId }))).toBe(NOT_ALLOWED);
    expect(await refusal(manager.mutation(api.configure.saveCosts, { companyId, ...COSTS }))).toBe(NOT_ALLOWED);
    expect(await refusal(manager.mutation(api.configure.saveOffering, { companyId, offered: ["res-standard"] }))).toBe(NOT_ALLOWED);
    expect((await manager.query(api.configure.workspace, { companyId })).canEdit).toBe(false);
    // Another company sees none of it.
    const other = await company(t, "owner-b", "Beta Cleaning");
    expect((await other.as.query(api.configure.workspace, { companyId: other.companyId })).started).toBe(false);
  });

  it("refuses to start without knowing who they clean for, and refuses a service that isn't offered", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    expect(await refusal(as.mutation(api.configure.start, { companyId }))).toMatch(/who you clean for/);
    expect(await refusal(as.mutation(api.configure.saveOffering, { companyId, offered: ["made-up"] }))).toMatch(/isn't one of the services/);
  });
});
