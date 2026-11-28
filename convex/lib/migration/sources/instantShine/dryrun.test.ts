/**
 * @vitest-environment edge-runtime
 *
 * The Bay Area dry run: runs the Instant Shine adapter on a snapshot kept OUTSIDE the repository and writes a
 * reconciliation report next to it. Skipped unless INSTANT_SHINE_SNAPSHOT points at a snapshot.json
 * ({ manifest, tables }), so no customer data is ever needed in Git.
 *
 *   INSTANT_SHINE_SNAPSHOT=/path/outside/git/snapshot.json INSTANT_SHINE_TODAY=2026-11-24 npx vitest run convex/lib/migration/sources/instantShine/dryrun
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { company, start, type T } from "../../../../../tests/harness";
import { api } from "../../../../_generated/api";
import type { Id } from "../../../../_generated/dataModel";
import { blankSpec } from "../../../services/spec";
import { adaptInstantShine, type Snapshot } from "./adapt";
import { serviceDrafts } from "./pricing";

const path = process.env.INSTANT_SHINE_SNAPSHOT;

describe.skipIf(!path)("Instant Shine dry run (snapshot outside Git)", () => {
  it("accounts for every source row and writes the reconciliation report", () => {
    const snapshot = JSON.parse(readFileSync(path!, "utf8")) as Snapshot;
    const today = process.env.INSTANT_SHINE_TODAY ?? new Date().toISOString().slice(0, 10);
    const adapted = adaptInstantShine(snapshot, { today });
    const unbalanced = adapted.reconciliation.filter((r) => !r.balanced);
    expect(unbalanced).toEqual([]);
    const summary = {
      instance: adapted.instance,
      snapshotAt: adapted.snapshotAt,
      today,
      staged: Object.fromEntries(adapted.files.map((f) => [f.kind, f.rows.length])),
      reconciliation: adapted.reconciliation,
      outcomes: adapted.records.reduce<Record<string, number>>((acc, r) => ((acc[r.outcome] = (acc[r.outcome] ?? 0) + 1), acc), {}),
      review: adapted.records.filter((r) => r.outcome === "review").map((r) => ({ table: r.table, id: r.id, reason: r.reason })),
      heldBack: adapted.flags.heldBack,
      flags: { ...adapted.flags, heldBack: adapted.flags.heldBack.length },
      config: adapted.config,
      finance: adapted.finance,
      links: adapted.links,
    };
    writeFileSync(join(dirname(path!), "dry-run-report.json"), JSON.stringify(summary, null, 2));
    writeFileSync(join(dirname(path!), "adapted.json"), JSON.stringify(adapted, null, 2));
  });
});

/**
 * The same snapshot through Selestial's real migration, in an in-memory deployment: staged, checked and imported
 * into a fresh workspace, never released. Writes what the importer did next to the snapshot.
 */
describe.skipIf(!path)("Instant Shine pilot import of the snapshot (in memory)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(`${process.env.INSTANT_SHINE_TODAY ?? new Date().toISOString().slice(0, 10)}T18:00:00Z`));
  });
  afterEach(() => vi.useRealTimers());

  it("stages, checks and imports the snapshot without sending, offering or charging anything", async () => {
    const snapshot = JSON.parse(readFileSync(path!, "utf8")) as Snapshot;
    const today = process.env.INSTANT_SHINE_TODAY ?? new Date().toISOString().slice(0, 10);
    const adapted = adaptInstantShine(snapshot, { today });
    const t: T = start();
    const settle = () => t.finishAllScheduledFunctions(vi.runAllTimers);
    const { as, companyId } = await company(t, "owner-dry-run", "Dry run workspace");
    const notice = { required: false, note: "" };
    for (const { spec } of serviceDrafts(blankSpec)) {
      const { serviceId } = await as.mutation(api.services.startDraft, { companyId, category: spec.category, spec: { ...spec, included: [{ id: "k", label: "Clean the kitchen", section: "Kitchen", requiresPhoto: false }] }, origin: "import" });
      const { changeId } = await as.mutation(api.services.submit, { companyId, serviceId, expectedRevision: 1, reason: "Dry run.", customerNotice: notice, contractReview: notice });
      const change = await as.query(api.services.change, { companyId, changeId });
      await as.mutation(api.services.approve, { companyId, changeId, hash: change.hash, publish: true });
    }
    await as.mutation(api.migration.open, { companyId });
    for (const file of adapted.files) {
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([file.header, file.rows]))))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const { fileId } = await as.mutation(api.migrationSources.stageFile, { companyId, source: "instant_shine", kind: file.kind, name: file.name, header: file.header, rowCount: file.rows.length, sha256: digest });
      for (let at = 0; at < file.rows.length; at += 400) await as.mutation(api.migrationSources.stageRows, { companyId, fileId, start: at, rows: file.rows.slice(at, at + 400).map((r) => r.cells) });
      await as.mutation(api.migrationSources.finishFile, { companyId, fileId });
    }
    await settle();
    const view = (await as.query(api.migration.view, { companyId }))!;
    for (const s of view.migration.serviceNames) {
      const match = view.services.find((service) => service.name === s.name);
      if (match) await as.mutation(api.migration.mapService, { companyId, name: s.name, serviceId: match.id });
    }
    await settle();
    const revision = (await as.query(api.migration.view, { companyId }))!.migration.revision;
    await as.mutation(api.migration.save, { companyId, revision, timezone: "America/Chicago", timezoneConfirmed: true });
    await settle();
    await as.mutation(api.migration.startImport, { companyId });
    await settle();
    const report = (await as.query(api.migration.report, { companyId }))!;
    const db = await t.run(async (ctx) => {
      const mine = <R extends { companyId: Id<"companies"> }>(rows: R[]) => rows.filter((r) => r.companyId === companyId);
      return {
        customers: mine(await ctx.db.query("customers").collect()).length,
        properties: mine(await ctx.db.query("properties").collect()).length,
        cleaners: mine(await ctx.db.query("cleaners").collect()).map((c) => ({ status: c.status, held: c.migration?.held })),
        jobs: mine(await ctx.db.query("jobs").collect()).length,
        plans: mine(await ctx.db.query("servicePlans").collect()).length,
        assignments: mine(await ctx.db.query("assignments").collect()).length,
        messages: mine(await ctx.db.query("messages").collect()).filter((m) => m.purpose !== "member_notice").length,
        coverage: mine(await ctx.db.query("coverageRequests").collect()).length,
        suppressions: mine(await ctx.db.query("suppressions").collect()).length,
      };
    });
    for (const kind of report.kinds) expect(kind, kind.kind).toMatchObject({ balanced: true });
    expect(db.messages).toBe(0);
    expect(db.coverage).toBe(0);
    const recurring = (await as.query(api.migration.rows, { companyId, kind: "recurring", filter: "all", offset: 0, limit: 100 })).rows;
    const problems = recurring.reduce<Record<string, number>>((acc, r) => {
      for (const p of r.problems) acc[p.replace(/[0-9a-f]{5} Main St/g, "…")] = (acc[p.replace(/[0-9a-f]{5} Main St/g, "…")] ?? 0) + 1;
      return acc;
    }, {});
    writeFileSync(join(dirname(path!), "pilot-import-report.json"), JSON.stringify({ kinds: report.kinds, problems: report.problems.length, recurringProblems: problems, db }, null, 2));
  }, 120_000);
});
