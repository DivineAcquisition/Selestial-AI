/**
 * Source adapters feeding the guided migration (docs/migration/instant-shine/00-plan.md). An adapter (for now
 * Instant Shine's, in lib/migration/sources/instantShine) turns a read-only export into rows in the importer's
 * own field format; these functions stage them as migration files, exactly as if a CSV had been mapped, so the
 * migration's check, review, import, release and undo apply unchanged.
 *
 * Staging is preparation: the Owner, a Manager, or a support session with records.edit may stage. Importing
 * and releasing stay with migration.startImport (Owner or Manager) and migration.release (Owner only), which
 * a support session can't call.
 *
 * Public: stageFile, stageRows, finishFile, saveReport, report
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { managerMutation, managerQuery, type MemberAccess } from "./lib/builders";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { FIELDS, IMPORTABLE, valuesOf, type Importable } from "./lib/migration/rules";
import { editable, LIMITS, requireMigration, scheduleCheck } from "./migration";

/** Sources whose rows arrive from an adapter rather than an uploaded CSV. */
const ADAPTER_SOURCES = ["instant_shine"] as const;
const adapterSourceValidator = v.union(...ADAPTER_SOURCES.map((s) => v.literal(s)));
/** Field keys a source adapter may send beyond the importer's own: an accepted crew on an upcoming visit. */
const EXTRA_FIELDS: Partial<Record<Importable, string[]>> = { bookings: ["crew"] };

async function adapterMigration(ctx: MutationCtx & MemberAccess, source: (typeof ADAPTER_SOURCES)[number]): Promise<Doc<"migrations">> {
  const migration = await requireMigration(ctx);
  editable(migration);
  if (migration.status === "released") throw userError("This migration has been released. Start the next import from the migration page.");
  if (migration.source !== source) {
    const files = (await ctx.db.query("migrationFiles").withIndex("by_migration", (q) => q.eq("migrationId", migration._id)).take(LIMITS.files + 20)).filter((f) => f.status !== "removed");
    // Records already imported from elsewhere keep their own namespace; mixing sources in one migration isn't allowed.
    if (files.length) throw userError("This migration already has files from another source. Remove them first, or finish that import.");
    await ctx.db.patch(migration._id, { source, updatedAt: Date.now() });
    return (await ctx.db.get(migration._id))!;
  }
  return migration;
}

/** Starts one staged file: what it holds and its columns, which are the importer's own field keys. */
export const stageFile = managerMutation({
  support: { capability: "records.edit", summary: "staged a file from a source export" },
  args: { source: adapterSourceValidator, kind: v.union(...IMPORTABLE.map((k) => v.literal(k))), name: v.string(), header: v.array(v.string()), rowCount: v.number(), sha256: v.string() },
  handler: async (ctx, args) => {
    const migration = await adapterMigration(ctx, args.source);
    const allowed = new Set([...FIELDS[args.kind].map((f) => f.key), ...(EXTRA_FIELDS[args.kind] ?? [])]);
    const unknown = args.header.filter((key) => !allowed.has(key));
    if (unknown.length) throw userError(`These columns aren't fields Selestial imports: ${unknown.slice(0, 5).join(", ")}.`);
    if (!/^[0-9a-f]{64}$/.test(args.sha256)) throw userError("The file's checksum is missing.");
    if (args.rowCount < 1 || args.rowCount > LIMITS.rowsPerFile) throw userError(`A staged file holds 1 to ${LIMITS.rowsPerFile} rows.`);
    const files = (await ctx.db.query("migrationFiles").withIndex("by_migration", (q) => q.eq("migrationId", migration._id)).take(LIMITS.files + 20)).filter((f) => f.status !== "removed");
    // The same export staged again is the same file: nothing is added twice.
    const same = files.find((f) => f.sha256 === args.sha256);
    if (same) return { fileId: same._id, already: true };
    if (files.length >= LIMITS.files) throw userError(`A migration can have up to ${LIMITS.files} files. Remove one first.`);
    const total = files.filter((f) => f.status === "ready").reduce((n, f) => n + f.rowCount, 0);
    if (total + args.rowCount > LIMITS.rows) throw userError(`Together the files would have more than ${LIMITS.rows} rows.`);
    const mapping = Object.fromEntries(args.header.map((key, i) => [key, i]));
    const fileId = await ctx.db.insert("migrationFiles", {
      companyId: ctx.companyId,
      migrationId: migration._id,
      name: args.name.trim().slice(0, 200) || "Staged file",
      size: 0,
      sha256: args.sha256,
      status: "reading",
      kind: args.kind,
      suggested: { kind: args.kind, because: [`Prepared by the ${args.source === "instant_shine" ? "Instant Shine" : args.source} adapter.`] },
      looksLike: null,
      header: args.header,
      rowCount: args.rowCount,
      mapping,
      mappingConfirmed: true,
      uploadedBy: byMember(ctx),
      createdAt: Date.now(),
    });
    await ctx.db.patch(migration._id, { step: migration.step === "source" ? "files" : migration.step, updatedAt: Date.now() });
    return { fileId, already: false };
  },
});

/** Adds rows to a staged file, in chunks. A chunk sent again after a retry isn't added twice. */
export const stageRows = managerMutation({
  support: { capability: "records.edit", summary: "staged rows from a source export" },
  args: { fileId: v.id("migrationFiles"), start: v.number(), rows: v.array(v.array(v.string())) },
  handler: async (ctx, args) => {
    const migration = await requireMigration(ctx);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.companyId !== ctx.companyId || file.migrationId !== migration._id) throw userError("Not found.", "not_found");
    if (file.status !== "reading") return { ok: false };
    if (args.rows.length > 400) throw userError("Send at most 400 rows at a time.");
    if (args.start + args.rows.length > file.rowCount) throw userError("More rows than the file said it holds.");
    const already = await ctx.db.query("migrationRows").withIndex("by_file", (q) => q.eq("fileId", file._id).eq("index", args.start)).first();
    if (already) return { ok: true };
    for (const [offset, raw] of args.rows.entries()) {
      const cells = file.header.map((_, i) => (raw[i] ?? "").slice(0, 2000));
      const values = valuesOf(cells, file.mapping);
      await ctx.db.insert("migrationRows", { companyId: file.companyId, migrationId: file.migrationId, fileId: file._id, kind: file.kind, index: args.start + offset, cells, values, edits: {}, ...(values.externalId ? { sourceId: values.externalId } : {}), state: "ready", problems: [], notes: [], matches: [] });
    }
    return { ok: true };
  },
});

/** Finishes a staged file once every row is in, and checks the migration. */
export const finishFile = managerMutation({
  support: { capability: "records.edit", summary: "finished staging a file from a source export" },
  args: { fileId: v.id("migrationFiles") },
  handler: async (ctx, args) => {
    const migration = await requireMigration(ctx);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.companyId !== ctx.companyId || file.migrationId !== migration._id) throw userError("Not found.", "not_found");
    if (file.status === "ready") return { ok: true };
    const staged = await ctx.db.query("migrationRows").withIndex("by_file", (q) => q.eq("fileId", file._id)).take(LIMITS.rowsPerFile + 1);
    if (staged.length !== file.rowCount) throw userError(`Only ${staged.length} of ${file.rowCount} rows arrived. Stage the file again.`);
    await ctx.db.patch(file._id, { status: "ready" });
    await scheduleCheck(ctx, (await ctx.db.get(migration._id))!);
    return { ok: true };
  },
});

/**
 * Keeps the adapter's report with the migration: what every source record became, the company settings it
 * read, the money as recorded, and outstanding links. It is for review and reconciliation; it changes nothing.
 */
export const saveReport = managerMutation({
  support: { capability: "records.edit", summary: "saved a source export's migration report" },
  args: { source: adapterSourceValidator, instance: v.string(), snapshotAt: v.union(v.string(), v.null()), report: v.string() },
  handler: async (ctx, args) => {
    const migration = await adapterMigration(ctx, args.source);
    if (args.report.length > 800_000) throw userError("This report is too large to keep with the migration.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.report);
    } catch {
      throw userError("The report isn't readable.");
    }
    if (!parsed || typeof parsed !== "object" || !("reconciliation" in parsed)) throw userError("The report isn't from a source adapter.");
    const row = await ctx.db.query("migrationSourceReports").withIndex("by_migration", (q) => q.eq("migrationId", migration._id)).first();
    const fields = { source: args.source, instance: args.instance.slice(0, 120), snapshotAt: args.snapshotAt, report: args.report, savedBy: byMember(ctx), savedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("migrationSourceReports", { companyId: ctx.companyId, migrationId: migration._id, ...fields });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "migration.source_report_saved", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { source: args.source, instance: args.instance.slice(0, 120) } });
    return { ok: true };
  },
});

export const report = managerQuery({
  args: {},
  handler: async (ctx) => {
    const migration = await ctx.db.query("migrations").withIndex("by_company", (q) => q.eq("companyId", ctx.companyId)).first();
    if (!migration) return null;
    const row = await ctx.db.query("migrationSourceReports").withIndex("by_migration", (q) => q.eq("migrationId", migration._id)).first();
    if (!row) return null;
    return { source: row.source, instance: row.instance, snapshotAt: row.snapshotAt, savedAt: row.savedAt, report: row.report };
  },
});
