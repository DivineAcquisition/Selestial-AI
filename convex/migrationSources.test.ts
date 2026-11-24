/**
 * @vitest-environment edge-runtime
 *
 * The Instant Shine pilot, end to end through the real migration: the adapter stages a de-identified export,
 * the migration checks and imports it, and nothing goes out. What must hold: every source record has an
 * outcome; an upcoming visit keeps its accepted total, its local time and its accepted crew with their recorded
 * pay, and no offer or message is sent; completed work is history; recurring customers wait for a real next
 * visit; opt-outs are applied; staging or importing twice duplicates nothing; another company sees none of it;
 * undo removes the untouched import, crew included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, refusal, start, type T } from "../tests/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { adaptInstantShine, type Adapted } from "./lib/migration/sources/instantShine/adapt";
import { FIXTURE, TODAY } from "./lib/migration/sources/instantShine/fixtures";
import { serviceDrafts } from "./lib/migration/sources/instantShine/pricing";
import { blankSpec, type Spec } from "./lib/services/spec";

type As = Awaited<ReturnType<typeof company>>["as"];
const notice = { required: false, note: "" };
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function publish(as: As, companyId: Id<"companies">, spec: Spec) {
  const { serviceId } = await as.mutation(api.services.startDraft, { companyId, category: spec.category, spec, origin: "import" });
  const { changeId } = await as.mutation(api.services.submit, { companyId, serviceId, expectedRevision: 1, reason: "Imported from Instant Shine.", customerNotice: notice, contractReview: notice });
  const change = await as.query(api.services.change, { companyId, changeId });
  await as.mutation(api.services.approve, { companyId, changeId, hash: change.hash, publish: true });
  return serviceId;
}

/** What the review screen does: stage each file in chunks, then keep the report. */
async function stage(as: As, companyId: Id<"companies">, adapted: Adapted) {
  for (const file of adapted.files) {
    const { fileId } = await as.mutation(api.migrationSources.stageFile, { companyId, source: "instant_shine", kind: file.kind, name: file.name, header: file.header, rowCount: file.rows.length, sha256: await sha256(JSON.stringify([file.header, file.rows])) });
    for (let at = 0; at < file.rows.length; at += 400) await as.mutation(api.migrationSources.stageRows, { companyId, fileId, start: at, rows: file.rows.slice(at, at + 400).map((r) => r.cells) });
    await as.mutation(api.migrationSources.finishFile, { companyId, fileId });
  }
  await as.mutation(api.migrationSources.saveReport, { companyId, source: "instant_shine", instance: adapted.instance, snapshotAt: adapted.snapshotAt, report: JSON.stringify({ reconciliation: adapted.reconciliation, records: adapted.records.length }) });
}

async function pilot() {
  const t = start();
  const { as, companyId } = await company(t, "owner-bay", "Pilot Cleaning");
  for (const { spec } of serviceDrafts(blankSpec)) await publish(as, companyId, { ...spec, included: [{ id: "kitchen", label: "Clean the kitchen", section: "Kitchen", requiresPhoto: false }] });
  await as.mutation(api.migration.open, { companyId });
  const adapted = adaptInstantShine(FIXTURE, { today: TODAY });
  await stage(as, companyId, adapted);
  await vi.runAllTimersAsync();
  await settle(t);
  return { t, as, companyId, adapted };
}

async function importAll(t: T, as: As, companyId: Id<"companies">) {
  const view = (await as.query(api.migration.view, { companyId }))!;
  for (const s of view.migration.serviceNames) {
    const match = view.services.find((service) => service.name === s.name);
    if (match) await as.mutation(api.migration.mapService, { companyId, name: s.name, serviceId: match.id });
  }
  await settle(t);
  const revision = (await as.query(api.migration.view, { companyId }))!.migration.revision;
  await as.mutation(api.migration.save, { companyId, revision, timezoneConfirmed: true });
  await settle(t);
  await as.mutation(api.migration.startImport, { companyId });
  await settle(t);
}

const everything = (t: T, companyId: Id<"companies">) =>
  t.run(async (ctx) => {
    const mine = <R extends { companyId: Id<"companies"> }>(rows: R[]) => rows.filter((r) => r.companyId === companyId);
    return {
      customers: mine(await ctx.db.query("customers").collect()),
      cleaners: mine(await ctx.db.query("cleaners").collect()),
      jobs: mine(await ctx.db.query("jobs").collect()),
      plans: mine(await ctx.db.query("servicePlans").collect()),
      history: mine(await ctx.db.query("importedHistory").collect()),
      assignments: mine(await ctx.db.query("assignments").collect()),
      suppressions: mine(await ctx.db.query("suppressions").collect()),
      messages: mine(await ctx.db.query("messages").collect()).filter((m) => m.purpose !== "member_notice"),
      coverage: mine(await ctx.db.query("coverageRequests").collect()),
      links: mine(await ctx.db.query("migrationLinks").collect()),
      balances: mine(await ctx.db.query("openingBalances").collect()),
    };
  });

describe("Instant Shine pilot migration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(`${TODAY}T15:00:00Z`));
  });
  afterEach(() => vi.useRealTimers());

  it("stages through the migration's own files and checks, and staging again adds nothing", async () => {
    const { t, as, companyId, adapted } = await pilot();
    const view = (await as.query(api.migration.view, { companyId }))!;
    expect(view.migration.source).toBe("instant_shine");
    expect(view.files.map((f) => [f.kind, f.status, f.rowCount, f.mappingConfirmed])).toEqual(adapted.files.map((f) => [f.kind, "ready", f.rows.length, true]));
    const before = await t.run(async (ctx) => (await ctx.db.query("migrationRows").collect()).length);
    await stage(as, companyId, adapted);
    expect(await t.run(async (ctx) => (await ctx.db.query("migrationRows").collect()).length)).toBe(before);
    expect((await as.query(api.migrationSources.report, { companyId }))!.instance).toBe(adapted.instance);
  });

  it("imports with the accepted crew, local time and accepted price, sends nothing, and imports nothing twice", async () => {
    const { t, as, companyId } = await pilot();
    await importAll(t, as, companyId);
    const all = await everything(t, companyId);

    // Customers: Ana, Ben, Cara and the four recurring customers (the test record was held back).
    expect(all.customers.map((c) => c.name).sort()).toEqual(["Ana Rivera", "Ben Ortiz", "Cara Ortiz", "Fran Hale", "Gus Park", "Hal Ward", "Ida Fox"]);
    // The text opt-out is applied to Ana before anything can message her.
    expect(all.suppressions.map((s) => [s.channel, s.address, s.scope])).toEqual([["sms", "+12815550101", "all"]]);

    // Cleaners: once each, onboarding and held. No invitation.
    expect(all.cleaners.map((c) => [c.name, c.status, c.migration?.held]).sort()).toEqual([
      ["Dee Lane", "onboarding", true],
      ["Eli Moss", "onboarding", true],
    ]);
    expect(all.cleaners.find((c) => c.name === "Eli Moss")!.email).toBeUndefined();

    // The upcoming visit: held, the accepted $262.04, 8:00 AM Central on Dec 10 (14:00 UTC), crew of two.
    expect(all.jobs).toHaveLength(1);
    const job = all.jobs[0];
    expect(job).toMatchObject({ priceCents: 26204, status: "scheduled", requiredCrew: 2, migration: { held: true } });
    expect(new Date(job.startsAt).toISOString()).toBe("2026-12-10T14:00:00.000Z");
    expect(job.endsAt - job.startsAt).toBe(240 * 60_000);
    expect(all.assignments.map((a) => [a.status, a.payCents, a.imported?.payLocked, a.imported?.source])).toEqual([
      ["accepted", 5240, false, "instant_shine"],
      ["accepted", 5240, false, "instant_shine"],
    ]);
    expect(new Date(all.assignments[0].respondedAt!).toISOString()).toBe("2026-11-28T15:00:00.000Z");
    // Ana has her own address and the second one her upcoming visit is at.
    const ana = all.customers.find((c) => c.name === "Ana Rivera")!;
    const anaProperties = await t.run(async (ctx) => (await ctx.db.query("properties").collect()).filter((p) => p.customerId === ana._id).map((p) => p.address.line1).sort());
    expect(anaProperties).toEqual(["100 Elm St", "110 Elm St"]);

    // Completed work is history; nothing collectible was created; nothing was sent or offered.
    expect(all.history.map((h) => [h.day, h.priceCents])).toEqual([["2026-11-02", 20278]]);
    expect(all.balances).toEqual([]);
    expect(all.messages).toEqual([]);
    expect(all.coverage).toEqual([]);

    // Recurring customers have no next visit in Instant Shine: no plan is invented.
    expect(all.plans).toEqual([]);
    const recurring = (await as.query(api.migration.rows, { companyId, kind: "recurring", filter: "all", offset: 0, limit: 50 })).rows;
    expect(recurring.map((r) => r.state)).toEqual(["error", "error", "error"]);
    expect(recurring.flatMap((r) => r.problems).join(" ")).toMatch(/next visit|custom/i);

    // Every staged row is accounted for.
    const report = (await as.query(api.migration.report, { companyId }))!;
    for (const kind of report.kinds) expect(kind, kind.kind).toMatchObject({ balanced: true });

    // Importing again duplicates nothing.
    await as.mutation(api.migration.startImport, { companyId }).catch(() => null);
    await settle(t);
    const again = await everything(t, companyId);
    expect([again.customers.length, again.cleaners.length, again.jobs.length, again.assignments.length, again.history.length]).toEqual([7, 2, 1, 2, 1]);
  });

  it("keeps it to its own company and lets only an Owner or Manager stage it", async () => {
    const { t, as, companyId } = await pilot();
    await importAll(t, as, companyId);
    const other = await company(t, "owner-other", "Other Cleaning");
    expect(await other.as.query(api.migrationSources.report, { companyId: other.companyId })).toBeNull();
    const theirs = await everything(t, other.companyId);
    expect([theirs.customers.length, theirs.jobs.length, theirs.cleaners.length]).toEqual([0, 0, 0]);
    const office = await addMember(t, as, companyId, "office-bay", "office");
    expect(await refusal(office.mutation(api.migrationSources.stageFile, { companyId, source: "instant_shine", kind: "customers", name: "x", header: ["externalId", "name"], rowCount: 1, sha256: "0".repeat(64) }))).toBeTruthy();
  });

  it("applies Instant Shine's crew pay to imported contractors only, keeping pay already set, and only for the Owner", async () => {
    const { t, as, companyId } = await pilot();
    await importAll(t, as, companyId);
    const [dee, eli] = (await everything(t, companyId)).cleaners.sort((a, b) => a.name.localeCompare(b.name));
    await t.run(async (ctx) => ctx.db.patch(eli._id, { pay: { kind: "share", shareBps: 3500 } }));
    const manager = await addMember(t, as, companyId, "manager-bay", "manager");
    expect(await refusal(manager.mutation(api.migrationSources.applyImportedPay, { companyId, shareBps: 4000 }))).toBeTruthy();
    expect(await as.mutation(api.migrationSources.applyImportedPay, { companyId, shareBps: 4000 })).toEqual({ set: 1, kept: 1 });
    const after = await everything(t, companyId);
    expect(after.cleaners.find((c) => c._id === dee._id)!.pay).toEqual({ kind: "share", shareBps: 4000 });
    expect(after.cleaners.find((c) => c._id === eli._id)!.pay).toEqual({ kind: "share", shareBps: 3500 });
    // The accepted visit keeps the pay recorded in Instant Shine, whatever the rule now says.
    expect(after.assignments.map((a) => a.payCents)).toEqual([5240, 5240]);
  });

  it("undoes the untouched import, its accepted crew included", async () => {
    const { t, as, companyId } = await pilot();
    await importAll(t, as, companyId);
    await as.mutation(api.migration.undo, { companyId, confirm: true, kinds: ["bookings", "history", "cleaners", "customers"] });
    await settle(t);
    const after = await everything(t, companyId);
    expect([after.jobs.length, after.assignments.length, after.cleaners.length, after.history.length]).toEqual([0, 0, 0, 0]);
  });
});
