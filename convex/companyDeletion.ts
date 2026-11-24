/**
 * Deleting a whole company, run by Selestial staff (docs/operations/07-account-closure.md). The Privacy
 * Notice promises a leaving company's records are deleted within 90 days; this is how that is honoured,
 * while keeping the records the law and the phone carriers require (convex/lib/trust/companyDeletion.ts).
 *
 * The order of things:
 *  1. A deletion request exists (the Owner asked in Settings, or the plan was cancelled for non-payment).
 *  2. Staff see the preconditions (forRequest). Each blocks until satisfied; an admin may waive the ones that
 *     can be waived, with a reason.
 *  3. A staff member with the destructive-actions capability starts it (start), typing the company's name.
 *     The company is marked closing: no member, support session, agent, message, Google write or link page
 *     acts for it from then on (convex/lib/builders.ts; suspension and paused agents for the rest).
 *  4. The run: Google, inboxes and Jobber are disconnected and their grants revoked; then every company
 *     table is worked through in bounded batches, each batch one transaction that also records progress, so
 *     an interrupted run resumes exactly where it stopped. A verification pass looks for rows that appeared
 *     after their table was done.
 *  5. The companies row becomes a tombstone, the request is completed with a summary, and one audit event is
 *     written.
 *
 * Nothing here ever starts by itself: the non-payment clock only opens the request.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { PaginationOptions, PaginationResult } from "convex/server";
import { disconnectConnectorsForDeletion } from "./connectors";
import { disconnectQuickBooksForDeletion } from "./quickbooks";
import { disconnectGoogleForDeletion } from "./google";
import { disconnectInboxesForDeletion } from "./inboxes";
import schema from "./schema";
import { ownerQuery, staffMutation, staffQuery, type StaffAccess } from "./lib/builders";
import { notFound, userError } from "./lib/errors";
import { recordEvent } from "./lib/events";
import { AGENTS } from "./lib/statuses";
import { capabilitiesOf } from "./lib/support/catalog";
import { numberRequest } from "./lib/texting/offboarding";
import {
  COMPANY_TOMBSTONE_CLEARS,
  DELETED_COMPANY,
  DELETION_PLAN,
  deleteFile,
  KEPT_FOR_OWNER,
  planPatch,
  retentionSummary,
  storageIds,
  type LooseValidator,
  type TablePlan,
} from "./lib/trust/companyDeletion";

const MINUTE = 60_000;

/** Rows per batch: far inside Convex's per-transaction read and write limits, files included. */
export const DEFAULT_BATCH = 100;
/** A run holds its lease this long between batches; another run may take over after it. */
const LEASE_MS = 5 * MINUTE;
/** Batches one action runs before handing over to a fresh one, well inside an action's time limit. */
const BATCHES_PER_RUN = 300;
/** Failed attempts in a row before the run stops and an incident is raised. */
export const MAX_ATTEMPTS = 5;
/** Verification passes before rows that keep appearing are treated as a failure. */
const MAX_PASSES = 3;

const CLOSED_REQUEST: readonly Doc<"trustRequests">["status"][] = ["completed", "closed_with_limitation", "spam"];

// ── Tables, loosely ───────────────────────────────────────────────────────────────────────────────

type SchemaTable = { validator: LooseValidator; " indexes"(): { indexDescriptor: string; fields: string[] }[] };
const TABLES = schema.tables as unknown as Record<string, SchemaTable>;

type Row = Record<string, unknown> & { _id: string; companyId?: string };
type LooseRange = { eq(field: string, value: unknown): LooseRange };
type LooseOrdered = { take(n: number): Promise<Row[]>; paginate(options: PaginationOptions): Promise<PaginationResult<Row>> };
type LooseQuery = LooseOrdered & {
  withIndex(name: string, range: (q: LooseRange) => unknown): LooseOrdered;
  filter(predicate: (q: { eq(a: unknown, b: unknown): unknown; field(name: string): unknown }) => unknown): LooseOrdered;
};
type LooseDb = { query(table: string): LooseQuery; delete(id: string): Promise<void>; patch(id: string, value: Record<string, unknown>): Promise<void> };
const loose = (ctx: QueryCtx | MutationCtx) => ctx.db as unknown as LooseDb;

/** The first index whose first field is companyId, or null (then rows are found by a filtered scan). */
export function companyIndex(table: string): string | null {
  const found = TABLES[table]?.[" indexes"]().find((index) => index.fields[0] === "companyId");
  return found?.indexDescriptor ?? null;
}

/** Top-level fields a plan rewrites. */
const rewrites = (plan: TablePlan) => new Set([...(plan.personal ?? []), ...(plan.hashed ?? [])].map((path) => path.split(".")[0]).concat(plan.derive ? ["evidence", "data"] : []));

/**
 * The companyId index a retained or anonymized table is paged through: one that holds none of the fields the
 * plan rewrites, so a rewritten row never moves ahead of the cursor and is never visited twice. Null when
 * the table has no such index (the classification test fails for that).
 */
export function pagingIndex(plan: TablePlan): string | null {
  const changed = rewrites(plan);
  const found = TABLES[plan.table]?.[" indexes"]().find((index) => index.fields[0] === "companyId" && !index.fields.some((field) => changed.has(field.split(".")[0])));
  return found?.indexDescriptor ?? null;
}

/** The company's rows of one table, through its companyId index, or a filtered scan of a small table. */
function rowsOf(ctx: QueryCtx | MutationCtx, table: string, companyId: Id<"companies">, via?: string | null): LooseOrdered {
  const query = loose(ctx).query(table);
  const index = via ?? companyIndex(table);
  return index ? query.withIndex(index, (q) => q.eq("companyId", companyId)) : query.filter((q) => q.eq(q.field("companyId"), companyId));
}

const fieldsOf = (table: string) => TABLES[table]?.validator.fields ?? {};

// ── Preconditions ─────────────────────────────────────────────────────────────────────────────────

export type PreconditionKey = "plan" | "payments" | "messaging" | "texting" | "connections" | "export";
export type Precondition = {
  key: PreconditionKey;
  label: string;
  state: "ok" | "blocking" | "waived" | "by_run" | "info";
  detail: string;
  waivable: boolean;
  waiver: { reason: string; at: number } | null;
};

/** Preconditions an admin may waive with a reason. The plan and the texting number never: they keep costing money. */
export const WAIVABLE: readonly PreconditionKey[] = ["payments", "messaging"];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function preconditions(ctx: QueryCtx | MutationCtx, company: Doc<"companies">, waivers: Doc<"companyDeletions">["waivers"]): Promise<Precondition[]> {
  const companyId = company._id;
  const out: Precondition[] = [];
  const waived = (key: PreconditionKey) => waivers.find((row) => row.key === key) ?? null;
  const item = (key: PreconditionKey, label: string, satisfied: boolean, detail: string) => {
    const waiver = !satisfied && WAIVABLE.includes(key) ? waived(key) : null;
    out.push({ key, label, state: satisfied ? "ok" : waiver ? "waived" : "blocking", detail, waivable: WAIVABLE.includes(key), waiver: waiver ? { reason: waiver.reason, at: waiver.at } : null });
  };

  // 1. Selestial's own plan: cancelled or ended.
  const accounts = await ctx.db
    .query("billingAccounts")
    .withIndex("by_company_env", (q) => q.eq("companyId", companyId))
    .take(5);
  // A plan set to end at the period's end counts as cancelled; one still renewing is active.
  const active = accounts.find((row) => row.plan !== null && row.subscription.endsAt === null);
  const legacyActive = accounts.length === 0 && (company.plan === "operate" || company.plan === "expand");
  item("plan", "No active paid plan", !active && !legacyActive, active || legacyActive ? `The ${active?.plan ?? company.plan} plan is still active. Cancel it in Autumn (or from Settings › Billing) first.` : accounts.some((row) => row.subscription.endsAt !== null) ? "The plan is cancelled." : "No paid plan.");

  // 2. Customer money in flight.
  const inFlight = [];
  for (const status of ["processing", "checking", "awaiting_customer"] as const) {
    inFlight.push(...(await ctx.db.query("payments").withIndex("by_company_status", (q) => q.eq("companyId", companyId).eq("status", status)).take(50)));
  }
  const unsettled = await ctx.db
    .query("refunds")
    .withIndex("by_company_settled", (q) => q.eq("companyId", companyId).eq("settledAt", undefined))
    .take(200);
  const refunds = unsettled.filter((row) => row.status === "sending" || row.status === "pending" || row.status === "checking");
  const succeeded = await ctx.db.query("payments").withIndex("by_company_status", (q) => q.eq("companyId", companyId).eq("status", "succeeded")).take(2000);
  const disputes = succeeded.filter((row) => row.dispute && !["won", "lost", "warning_closed"].includes(row.dispute.status));
  const openInvoices = await ctx.db.query("invoices").withIndex("by_company_status", (q) => q.eq("companyId", companyId).eq("status", "open")).take(200);
  const money = [inFlight.length ? plural(inFlight.length, "card payment in progress", "card payments in progress") : "", refunds.length ? plural(refunds.length, "refund in progress", "refunds in progress") : "", disputes.length ? plural(disputes.length, "open dispute", "open disputes") : "", openInvoices.length ? plural(openInvoices.length, "open invoice", "open invoices") : ""].filter(Boolean);
  item("payments", "No customer payments, refunds or disputes in flight", money.length === 0, money.length ? `${money.join(", ")}. Let them settle, or have the Owner void the invoices.` : "Nothing in flight.");

  // 3. Messaging charges not yet settled with Autumn.
  const charges = await ctx.db.query("messagingCharges").withIndex("by_company_created", (q) => q.eq("companyId", companyId)).order("desc").take(2000);
  const open = charges.filter((row) => row.state === "estimated" || row.state === "reserving" || row.state === "reserved" || row.state === "pending");
  item("messaging", "No unsettled messaging charges", open.length === 0, open.length ? `${plural(open.length, "messaging charge is", "messaging charges are")} not settled. They settle on their own within the hour; see Staff › Messaging.` : "All settled.");

  // 4. The texting number: released or moved (docs/texting/03-offboarding.md).
  const number = await numberRequest(ctx, companyId);
  item("texting", "Texting number released or transferred", number === null, number ? `${number.phoneNumber} is still on Selestial's account. Release it or complete the transfer from Staff › Texting, with the Owner's recorded authorization.` : "No texting number.");

  // 5. Connections: the run disconnects them first.
  const google = (await ctx.db.query("googleConnections").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(50)).filter((row) => row.status !== "disconnected").length;
  const inboxes = (await ctx.db.query("mailboxConnections").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(50)).filter((row) => row.status !== "disconnected").length;
  const connectors = (await ctx.db.query("connectorConnections").withIndex("by_company_system", (q) => q.eq("companyId", companyId)).take(20)).filter((row) => row.status !== "disconnected").length;
  const quickbooks = (await ctx.db.query("quickbooksConnections").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(20)).filter((row) => row.status !== "disconnected").length;
  const live = google + inboxes + connectors + quickbooks;
  out.push({ key: "connections", label: "Google, inboxes, Jobber and QuickBooks disconnected", state: live ? "by_run" : "ok", detail: live ? `${plural(live, "connection is", "connections are")} live. The run disconnects them and revokes the grants as its first step.` : "Nothing connected.", waivable: false, waiver: null });

  // 6. The export: offered, not required.
  const exports = await ctx.db.query("dataExports").withIndex("by_company_created", (q) => q.eq("companyId", companyId)).order("desc").take(50);
  const downloaded = exports.find((row) => row.downloadedAt !== undefined);
  out.push({ key: "export", label: "Owner offered an export", state: "info", detail: downloaded ? `Downloaded ${new Date(downloaded.downloadedAt!).toISOString().slice(0, 10)}.` : "No export was downloaded. Not required; confirm the Owner was offered one.", waivable: false, waiver: null });
  return out;
}

export const blocking = (items: Precondition[]) => items.filter((row) => row.state === "blocking");

// ── Staff: the request's deletion view ────────────────────────────────────────────────────────────

async function deletionRequest(ctx: QueryCtx | MutationCtx, requestId: Id<"trustRequests">) {
  const request = await ctx.db.get(requestId);
  if (!request) notFound();
  if (request.kind !== "privacy" || request.subtype !== "deletion" || !request.companyId) return null;
  const company = await ctx.db.get(request.companyId);
  if (!company) return null;
  const deletion = await ctx.db
    .query("companyDeletions")
    .withIndex("by_company", (q) => q.eq("companyId", company._id))
    .order("desc")
    .first();
  return { request, company, deletion };
}

export const forRequest = staffQuery({
  args: { requestId: v.id("trustRequests") },
  handler: async (ctx, args) => {
    const found = await deletionRequest(ctx, args.requestId);
    if (!found) return null;
    const { request, company, deletion } = found;
    const items = company.deletedAt === undefined ? await preconditions(ctx, company, deletion?.waivers ?? []) : [];
    const capabilities = capabilitiesOf(ctx.staff);
    const tables = deletion?.tables ?? [];
    const totals = tables.reduce((sum, row) => ({ deleted: sum.deleted + row.deleted, anonymized: sum.anonymized + row.anonymized, retained: sum.retained + row.retained, files: sum.files + row.files }), { deleted: 0, anonymized: 0, retained: 0, files: 0 });
    return {
      companyId: company._id,
      companyName: company.name,
      closing: company.closingAt !== undefined,
      deleted: company.deletedAt !== undefined,
      requestOpen: !CLOSED_REQUEST.includes(request.status),
      dueOn: request.dueOn ?? null,
      preconditions: items,
      canStart: blocking(items).length === 0,
      retention: retentionSummary(),
      viewer: { canDestroy: capabilities.has("records.destroy"), admin: ctx.staff.role === "admin" },
      run: deletion
        ? {
            id: deletion._id,
            status: deletion.status,
            phase: deletion.phase,
            startedAt: deletion.startedAt ?? null,
            finishedAt: deletion.finishedAt ?? null,
            tablesDone: tables.filter((row) => row.done).length,
            tablesTotal: tables.length,
            current: DELETION_PLAN[deletion.tableIndex]?.table ?? null,
            totals,
            tables,
            errors: deletion.errors.slice(-10),
            attempts: deletion.attempts,
            summary: deletion.summary ?? null,
            disconnected: deletion.disconnected ?? null,
            exportDownloadedAt: deletion.exportDownloadedAt ?? null,
          }
        : null,
    };
  },
});

async function preparing(ctx: MutationCtx, request: Doc<"trustRequests">, company: Doc<"companies">, deletion: Doc<"companyDeletions"> | null): Promise<Doc<"companyDeletions">> {
  if (deletion && deletion.status !== "completed") return deletion;
  const now = Date.now();
  const id = await ctx.db.insert("companyDeletions", {
    companyId: company._id,
    requestId: request._id,
    status: "preparing",
    waivers: [],
    batchSize: DEFAULT_BATCH,
    phase: "disconnect",
    tableIndex: 0,
    cursor: null,
    passes: 0,
    tables: DELETION_PLAN.map((plan) => ({ table: plan.table, treatment: plan.treatment, deleted: 0, anonymized: 0, retained: 0, files: 0, done: false })),
    errors: [],
    attempts: 0,
    createdAt: now,
  });
  return (await ctx.db.get(id))!;
}

const requestAct = async (ctx: MutationCtx & StaffAccess, request: Doc<"trustRequests">, action: string, detail: string, patch: Partial<Doc<"trustRequests">> = {}) => {
  const fresh = (await ctx.db.get(request._id))!;
  await ctx.db.patch(request._id, { ...patch, actions: [...fresh.actions, { at: Date.now(), by: ctx.staff._id as string, action, detail }] });
};

/** An admin waives one precondition that may be waived, saying why. Recorded on the deletion and the request. */
export const waive = staffMutation({
  adminOnly: true,
  capability: "records.destroy",
  args: { requestId: v.id("trustRequests"), key: v.union(v.literal("payments"), v.literal("messaging")), reason: v.string() },
  handler: async (ctx, args) => {
    const found = await deletionRequest(ctx, args.requestId);
    if (!found) notFound();
    if (CLOSED_REQUEST.includes(found.request.status)) throw userError("This request is closed.");
    if (found.company.closingAt !== undefined) throw userError("The deletion has already started.");
    const reason = args.reason.trim();
    if (reason.length < 10) throw userError("Say why, so the next person can tell what happened.");
    const deletion = await preparing(ctx, found.request, found.company, found.deletion);
    const now = Date.now();
    await ctx.db.patch(deletion._id, { waivers: [...deletion.waivers.filter((row) => row.key !== args.key), { key: args.key, reason: reason.slice(0, 500), by: ctx.staff._id, at: now }] });
    await requestAct(ctx, found.request, "deletion_waiver", `Waived "${args.key}" for the company deletion: ${reason.slice(0, 500)}`);
    return null;
  },
});

/**
 * Starts the deletion. Destructive-actions capability only, on this company's open deletion request, with
 * the company's name typed exactly. Every precondition must be satisfied or waived.
 */
export const start = staffMutation({
  capability: "records.destroy",
  args: { requestId: v.id("trustRequests"), confirmName: v.string() },
  handler: async (ctx, args) => {
    const found = await deletionRequest(ctx, args.requestId);
    if (!found) throw userError("This request is not a request to delete a company.");
    const { request, company } = found;
    if (CLOSED_REQUEST.includes(request.status)) throw userError("This request is closed.");
    if (company.closingAt !== undefined || company.deletedAt !== undefined) throw userError("The deletion has already started.");
    if (args.confirmName.trim() !== company.name.trim()) throw userError("Type the company's name exactly as shown to confirm.");
    const deletion = await preparing(ctx, request, company, found.deletion);
    const items = await preconditions(ctx, company, deletion.waivers);
    const stopped = blocking(items);
    if (stopped.length) throw userError(`Not yet: ${stopped.map((row) => row.label.toLowerCase()).join("; ")}.`);
    const now = Date.now();
    const exports = await ctx.db.query("dataExports").withIndex("by_company_created", (q) => q.eq("companyId", company._id)).order("desc").take(50);
    const downloaded = exports.find((row) => row.downloadedAt !== undefined)?.downloadedAt ?? null;
    await ctx.db.patch(deletion._id, { status: "running", startedBy: ctx.staff._id, startedAt: now, lastProgressAt: now, exportDownloadedAt: downloaded, attempts: 0 });
    // Closing: the builders refuse everyone; suspension stops every send; every agent is paused.
    await ctx.db.patch(company._id, { closingAt: now, suspendedAt: company.suspendedAt ?? now, pausedAgents: [...AGENTS] });
    await requestAct(ctx, request, "deletion_started", `Company deletion started. The company is closed to its team, its links and its agents.${downloaded ? "" : " No export was downloaded."}`, { status: "in_progress" });
    await ctx.scheduler.runAfter(0, internal.companyDeletion.run, { deletionId: deletion._id });
    return { deletionId: deletion._id };
  },
});

/** Starts a failed run again from where it stopped. */
export const resume = staffMutation({
  capability: "records.destroy",
  args: { requestId: v.id("trustRequests") },
  handler: async (ctx, args) => {
    const found = await deletionRequest(ctx, args.requestId);
    if (!found?.deletion || found.deletion.status !== "failed") throw userError("There is no stopped deletion to resume.");
    await ctx.db.patch(found.deletion._id, { status: "running", attempts: 0, leaseToken: undefined, leaseUntil: undefined, lastProgressAt: Date.now() });
    await requestAct(ctx, found.request, "deletion_resumed", "Company deletion resumed from where it stopped.");
    await ctx.scheduler.runAfter(0, internal.companyDeletion.run, { deletionId: found.deletion._id });
    return null;
  },
});

// ── The run ───────────────────────────────────────────────────────────────────────────────────────

function newToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const claim = internalMutation({
  args: { deletionId: v.id("companyDeletions"), token: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db.get(args.deletionId);
    if (!row || row.status !== "running") return false;
    const now = Date.now();
    if (row.leaseToken && row.leaseToken !== args.token && (row.leaseUntil ?? 0) > now) return false;
    await ctx.db.patch(row._id, { leaseToken: args.token, leaseUntil: now + LEASE_MS });
    return true;
  },
});

type BatchResult = "more" | "done" | "stopped";

/** One table's batch: applies its plan to up to batchSize rows. Returns the counts and whether the table is finished. */
async function tableBatch(ctx: MutationCtx, plan: TablePlan, companyId: Id<"companies">, size: number, cursor: string | null) {
  const counts = { deleted: 0, anonymized: 0, retained: 0, files: 0 };
  const validator = TABLES[plan.table].validator;
  const fields = fieldsOf(plan.table);
  const remove = async (row: Row) => {
    for (const file of storageIds(row, validator)) if (await deleteFile(ctx, file)) counts.files += 1;
    await loose(ctx).delete(row._id);
    counts.deleted += 1;
  };
  if (plan.treatment === "delete") {
    // Deleted rows leave the index, so the first rows are always the next ones: no cursor needed.
    const rows = await rowsOf(ctx, plan.table, companyId).take(size);
    for (const row of rows) if (row.companyId === companyId) await remove(row);
    return { counts, done: rows.length < size, cursor: null };
  }
  if (plan.uncounted) return { counts, done: true, cursor: null };
  const index = pagingIndex(plan);
  if (!index) throw new Error(`No index to page ${plan.table} through that the plan does not rewrite.`);
  const page = await rowsOf(ctx, plan.table, companyId, index).paginate({ cursor, numItems: size });
  for (const row of page.page) {
    if (row.companyId !== companyId) continue;
    if (plan.keepRow && !plan.keepRow(row)) {
      await remove(row);
      continue;
    }
    const patch = await planPatch(ctx, plan, row, fields);
    if (Object.keys(patch).length) {
      const before = storageIds(row, validator);
      const after = storageIds({ ...row, ...patch }, validator);
      for (const file of before) if (!after.has(file) && (await deleteFile(ctx, file))) counts.files += 1;
      await loose(ctx).patch(row._id, patch);
    }
    if (plan.treatment === "anonymize") counts.anonymized += 1;
    else counts.retained += 1;
  }
  return { counts, done: page.isDone, cursor: page.isDone ? null : page.continueCursor };
}

/** One step of the run, in one transaction with the progress it records. */
export const batch = internalMutation({
  args: { deletionId: v.id("companyDeletions"), token: v.string() },
  handler: async (ctx, args): Promise<BatchResult> => {
    const row = await ctx.db.get(args.deletionId);
    if (!row || row.status !== "running" || row.leaseToken !== args.token) return "stopped";
    const company = await ctx.db.get(row.companyId);
    if (!company) throw new Error("The company row is missing.");
    const now = Date.now();
    const progress = { lastProgressAt: now, leaseUntil: now + LEASE_MS };

    if (row.phase === "disconnect") {
      // First: nothing may reach Google, an inbox or Jobber for this company again.
      const google = await disconnectGoogleForDeletion(ctx, company._id);
      const inboxes = await disconnectInboxesForDeletion(ctx, company._id);
      // Jobber, Housecall Pro and QuickBooks are counted together as connected systems.
      const connectors = (await disconnectConnectorsForDeletion(ctx, company._id)) + (await disconnectQuickBooksForDeletion(ctx, company._id));
      await ctx.db.patch(row._id, { ...progress, phase: "tables", tableIndex: 0, cursor: null, disconnected: { google, inboxes, connectors } });
      return "more";
    }

    if (row.phase === "tables") {
      const plan = DELETION_PLAN[row.tableIndex];
      if (!plan) {
        await ctx.db.patch(row._id, { ...progress, phase: "verify", cursor: null });
        return "more";
      }
      const tables = [...row.tables];
      const at = tables.findIndex((entry) => entry.table === plan.table);
      if (!TABLES[plan.table]) {
        // Listed for a table other work may add later; nothing to do yet.
        if (at >= 0) tables[at] = { ...tables[at], done: true };
        await ctx.db.patch(row._id, { ...progress, tables, tableIndex: row.tableIndex + 1, cursor: null });
        return "more";
      }
      let result;
      try {
        result = await tableBatch(ctx, plan, company._id, row.batchSize, row.cursor);
      } catch (error) {
        throw new Error(`${plan.table}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (at >= 0) {
        const entry = tables[at];
        tables[at] = { ...entry, deleted: entry.deleted + result.counts.deleted, anonymized: entry.anonymized + result.counts.anonymized, retained: entry.retained + result.counts.retained, files: entry.files + result.counts.files, done: result.done };
      }
      await ctx.db.patch(row._id, { ...progress, tables, attempts: 0, ...(result.done ? { tableIndex: row.tableIndex + 1, cursor: null } : { cursor: result.cursor }) });
      return "more";
    }

    if (row.phase === "verify") {
      // Rows written after their table was done (a writer that slipped past the closing) are found here.
      let again = -1;
      for (let i = 0; i < DELETION_PLAN.length; i += 1) {
        const plan = DELETION_PLAN[i];
        if (plan.treatment !== "delete" || !TABLES[plan.table]) continue;
        const rest = await rowsOf(ctx, plan.table, company._id).take(1);
        if (rest.length) {
          again = i;
          break;
        }
      }
      if (again >= 0) {
        if (row.passes + 1 >= MAX_PASSES) throw new Error(`Rows keep appearing in ${DELETION_PLAN[again].table}. Find the writer that ignores the closing before resuming.`);
        await ctx.db.patch(row._id, { ...progress, phase: "tables", tableIndex: again, cursor: null, passes: row.passes + 1, tables: row.tables.map((entry) => (entry.table === DELETION_PLAN[again].table ? { ...entry, done: false } : entry)) });
        return "more";
      }
      await ctx.db.patch(row._id, { ...progress, phase: "finish" });
      return "more";
    }

    if (row.phase === "finish") {
      const totals = row.tables.reduce((sum, entry) => ({ deleted: sum.deleted + entry.deleted, anonymized: sum.anonymized + entry.anonymized, retained: sum.retained + entry.retained, files: sum.files + entry.files }), { deleted: 0, anonymized: 0, retained: 0, files: 0 });
      const kinds = (treatment: TablePlan["treatment"]) => row.tables.filter((entry) => entry.treatment === treatment).length;
      const summary =
        `Company deleted. ${totals.deleted} rows deleted across ${kinds("delete")} tables, with ${totals.files} stored files; ` +
        `${totals.anonymized} rows anonymized in ${kinds("anonymize")} tables (customers, properties, cleaners, visits, assignments and hiring lines that retained financial rows point at); ` +
        `${totals.retained} rows kept in ${kinds("retain")} tables (consent and opt-out records with addresses hashed, sending records without their words, invoices, payments, refunds, tips and payouts, the texting registration, Selestial's billing ledger, and the request records), with personal text stripped where possible. ` +
        `Memberships were removed; sign-in accounts were not deleted, because a person may belong to other companies. Backups age out on the database provider's schedule.`;
      const clears: Record<string, undefined> = {};
      for (const field of COMPANY_TOMBSTONE_CLEARS) clears[field] = undefined;
      await ctx.db.patch(company._id, { ...clears, name: DELETED_COMPANY, deletedAt: now, pausedAgents: [...AGENTS], suspendedAt: company.suspendedAt ?? now });
      const request = await ctx.db.get(row.requestId);
      const staffId = row.startedBy;
      if (request) {
        await ctx.db.patch(request._id, {
          ...(CLOSED_REQUEST.includes(request.status) ? {} : { status: "completed" as const, completion: { at: now, by: (staffId as string | undefined) ?? "system", outcome: summary } }),
          actions: [...request.actions, { at: now, by: (staffId as string | undefined) ?? "system", action: "completed", detail: summary }],
        });
      }
      // The one audit event of the deletion. Events have no staff actor kind: the staff member is in data, as texting does it.
      await recordEvent(ctx, { companyId: company._id, type: "company.deleted", actor: { kind: "system" }, subject: { table: "companies", id: company._id }, data: { staffId: (staffId as string | undefined) ?? null, deletionId: row._id, deleted: totals.deleted, anonymized: totals.anonymized, retained: totals.retained, files: totals.files } });
      await ctx.db.patch(row._id, { status: "completed", phase: "done", finishedAt: now, summary, leaseToken: undefined, leaseUntil: undefined, lastProgressAt: now });
      return "done";
    }
    return "done";
  },
});

export const failed = internalMutation({
  args: { deletionId: v.id("companyDeletions"), token: v.string(), message: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.deletionId);
    if (!row || row.status !== "running" || row.leaseToken !== args.token) return null;
    const attempts = row.attempts + 1;
    const table = row.phase === "tables" ? DELETION_PLAN[row.tableIndex]?.table : undefined;
    const errors = [...row.errors, { at: Date.now(), ...(table ? { table } : {}), message: args.message.slice(0, 500) }].slice(-50);
    if (attempts >= MAX_ATTEMPTS) {
      await ctx.db.patch(row._id, { attempts, errors, status: "failed", leaseToken: undefined, leaseUntil: undefined });
      return null;
    }
    await ctx.db.patch(row._id, { attempts, errors, leaseToken: undefined, leaseUntil: undefined });
    await ctx.scheduler.runAfter(attempts * MINUTE, internal.companyDeletion.run, { deletionId: row._id });
    return null;
  },
});

/** Hands the run over to a fresh action, so no single action runs long. */
export const handOver = internalMutation({
  args: { deletionId: v.id("companyDeletions"), token: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.deletionId);
    if (!row || row.status !== "running" || row.leaseToken !== args.token) return null;
    await ctx.db.patch(row._id, { leaseToken: undefined, leaseUntil: undefined });
    await ctx.scheduler.runAfter(0, internal.companyDeletion.run, { deletionId: row._id });
    return null;
  },
});

export const run = internalAction({
  args: { deletionId: v.id("companyDeletions") },
  handler: async (ctx, args): Promise<void> => {
    const token = newToken();
    if (!(await ctx.runMutation(internal.companyDeletion.claim, { deletionId: args.deletionId, token }))) return;
    for (let i = 0; i < BATCHES_PER_RUN; i += 1) {
      let result: BatchResult;
      try {
        result = await ctx.runMutation(internal.companyDeletion.batch, { deletionId: args.deletionId, token });
      } catch (error) {
        await ctx.runMutation(internal.companyDeletion.failed, { deletionId: args.deletionId, token, message: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (result !== "more") return;
    }
    await ctx.runMutation(internal.companyDeletion.handOver, { deletionId: args.deletionId, token });
  },
});

// ── The Owner's view ──────────────────────────────────────────────────────────────────────────────

/**
 * The company's deletion request, for the Owner: received (and the date it will be done by), in progress,
 * or completed, and what is kept and why. Readable while locked and while the company is closing.
 */
export const status = ownerQuery({
  args: {},
  whileLocked: true,
  whileClosing: true,
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("trustRequests")
      .withIndex("by_company_received", (q) => q.eq("companyId", ctx.companyId))
      .order("desc")
      .take(50);
    const request = rows.find((row) => row.kind === "privacy" && row.subtype === "deletion" && row.status !== "spam");
    if (!request) return null;
    const deletion = await ctx.db
      .query("companyDeletions")
      .withIndex("by_request", (q) => q.eq("requestId", request._id))
      .first();
    const running = deletion?.status === "running" || deletion?.status === "failed" || ctx.company.closingAt !== undefined;
    const state = request.status === "completed" || request.status === "closed_with_limitation" ? ("completed" as const) : running || request.status === "in_progress" ? ("in_progress" as const) : ("received" as const);
    const tables = deletion?.tables ?? [];
    return {
      reference: request.reference,
      state,
      receivedAt: request.receivedAt,
      dueOn: request.dueOn ?? null,
      startedAt: deletion?.startedAt ?? null,
      completedAt: request.completion?.at ?? deletion?.finishedAt ?? null,
      progress: tables.length ? { done: tables.filter((row) => row.done).length, total: tables.length } : null,
      kept: KEPT_FOR_OWNER,
    };
  },
});
