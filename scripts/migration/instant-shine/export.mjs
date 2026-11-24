#!/usr/bin/env node
/**
 * Read-only export of an Instant Shine (Supabase) instance, for Selestial's migration adapter
 * (docs/migration/instant-shine/00-plan.md).
 *
 * Usage:
 *   INSTANT_SHINE_URL=https://<ref>.supabase.co INSTANT_SHINE_KEY=<service key> \
 *     node scripts/migration/instant-shine/export.mjs --out /path/outside/git [--instance <ref>]
 *
 * In a cloud session the key can instead be injected by the network proxy for the instance's host
 * (then INSTANT_SHINE_KEY may be any placeholder). The key is never written anywhere.
 *
 * What it does, and only this:
 *  - GETs every exported table through PostgREST, ordered by primary key, in pages. Nothing is written
 *    to the source: there is no POST, PATCH or DELETE in this file.
 *  - Drops credential tables entirely and strips reusable bearer tokens from rows, keeping only that a
 *    link existed (`<column>__present: true`), so outstanding links can be inventoried without copying them.
 *  - Lists storage objects in the private buckets and downloads their bytes with checksums.
 *  - Writes one NDJSON file per table, the files, and manifest.json (version, instance, timestamps,
 *    counts, sha256 per file) into --out. --out must be outside the repository.
 *  - Counts every table again at the end; if a count moved, the manifest says the snapshot is not
 *    consistent and which tables moved, so the export is taken again or a delta is planned.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPORT_VERSION = 1;

/**
 * Every source table and how it is exported. `pk` orders pages. `strip` lists bearer-token columns
 * replaced by a presence flag. Tables in SKIPPED are never read. Kept in step with the adapter's
 * catalog (convex/lib/migration/sources/instantShine/catalog.ts); a test checks they agree.
 */
export const TABLES = [
  // Company configuration
  { table: "business_calendar_settings", pk: "id" },
  { table: "availability_schedule", pk: "id" },
  { table: "service_areas", pk: "zip_code" },
  { table: "payroll_settings", pk: "id" },
  { table: "cleaner_pay_rates", pk: "id" },
  { table: "promo_codes", pk: "id" },
  { table: "promo_redemptions", pk: "id" },
  { table: "referral_codes", pk: "id" },
  { table: "referral_uses", pk: "id" },
  { table: "job_checklists", pk: "id", strip: ["token"] },
  // Customers, leads and quotes
  { table: "customers", pk: "id" },
  { table: "partial_bookings", pk: "id" },
  { table: "commercial_estimates", pk: "id" },
  { table: "va_quotes", pk: "id" },
  // Operations
  { table: "bookings", pk: "id", strip: ["manage_token", "pay_page_token", "photo_upload_token", "photo_view_token", "payment_link_url"] },
  { table: "booking_events", pk: "id" },
  { table: "booking_notes", pk: "id" },
  { table: "orders", pk: "id" },
  { table: "order_status_updates", pk: "id" },
  { table: "order_tips", pk: "id" },
  { table: "service_modifications", pk: "id" },
  { table: "payroll_recurring_clients", pk: "id" },
  { table: "payroll_recurring_assignments", pk: "id" },
  { table: "payroll_jobs", pk: "id" },
  { table: "payroll_job_assignments", pk: "id" },
  { table: "job_tracking", pk: "id" },
  { table: "job_field_notes", pk: "id" },
  { table: "job_documentation", pk: "id" },
  // People
  { table: "subcontractors", pk: "id" },
  { table: "payroll_contractors", pk: "id" },
  { table: "subcontractor_job_assignments", pk: "id", strip: ["response_token"] },
  { table: "subcontractor_applications", pk: "id" },
  { table: "subcontractor_restrictions", pk: "id" },
  { table: "subcontractor_job_drops", pk: "id" },
  { table: "cleaner_extra_pay", pk: "id" },
  { table: "performance_metrics", pk: "id" },
  { table: "profiles", pk: "id" },
  { table: "user_roles", pk: "id" },
  // Quality, agreements
  { table: "customer_feedback", pk: "id" },
  { table: "qc_issues", pk: "id" },
  { table: "qc_issue_events", pk: "id" },
  { table: "incidents", pk: "id" },
  { table: "service_agreements", pk: "id" },
  { table: "contracts", pk: "id" },
  // Communications
  { table: "email_logs", pk: "id" },
  { table: "sms_logs", pk: "id" },
  { table: "messages", pk: "id" },
  { table: "sms_opt_outs", pk: "id" },
  { table: "sms_intents", pk: "id" },
  { table: "email_retry_queue", pk: "id" },
  // Integration references (no credentials)
  { table: "ghl_integration_config", pk: "id" },
  { table: "ghl_sync_log", pk: "id" },
  { table: "jobber_integration_config", pk: "id" },
  { table: "jobber_lead_links", pk: "id" },
  { table: "jobber_sync_log", pk: "id" },
  { table: "jobber_sync_queue", pk: "id" },
  { table: "jobber_webhook_events", pk: "id" },
  { table: "busy_slots", pk: "id" },
  { table: "companies", pk: "id" },
];

/** Never read: credentials, OAuth state and reusable sign-in or onboarding links. */
export const SKIPPED = {
  ghl_private_credentials: "Provider credentials. Never copied.",
  jobber_credentials: "Provider OAuth tokens. Never copied.",
  jobber_oauth_states: "OAuth handshake state. Never copied.",
  user_calendar_tokens: "Google OAuth tokens. Never copied.",
  interview_tokens: "Reusable applicant links. Inventoried by count only.",
  subcontractor_onboarding_tokens: "Reusable onboarding links. Inventoried by count only.",
  auth_redirects: "Sign-in redirect state. Never copied.",
  security_logs: "Source application security log; not business data.",
  interview_slots: "Source interview scheduling; no rows at export time and no Selestial equivalent.",
};

export const BUCKETS = ["job-photos", "service-agreements"];
const PAGE = 500;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** A row with bearer tokens replaced by presence flags. Pure, for tests. */
export function stripRow(row, columns = []) {
  if (!columns.length) return row;
  const out = { ...row };
  for (const column of columns) {
    if (!(column in out)) continue;
    out[`${column}__present`] = out[column] !== null && out[column] !== "";
    delete out[column];
  }
  return out;
}

function headers(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json", ...extra };
}

async function count(base, key, table) {
  const res = await fetch(`${base}/rest/v1/${table}?select=*&limit=1`, { method: "HEAD", headers: headers(key, { Prefer: "count=exact" }) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`count ${table}: HTTP ${res.status}`);
  const range = res.headers.get("content-range") ?? "*/0";
  return Number(range.split("/")[1] ?? 0);
}

async function readTable(base, key, spec) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${base}/rest/v1/${spec.table}?select=*&order=${spec.pk}.asc&offset=${offset}&limit=${PAGE}`;
    const res = await fetch(url, { headers: headers(key) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`read ${spec.table}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    rows.push(...page.map((row) => stripRow(row, spec.strip)));
    if (page.length < PAGE) return rows;
  }
}

async function listBucket(base, key, bucket, prefix = "") {
  const res = await fetch(`${base}/storage/v1/object/list/${bucket}`, { method: "POST", headers: headers(key, { "Content-Type": "application/json" }), body: JSON.stringify({ prefix, limit: 1000, offset: 0 }) });
  // Listing is a read, even though storage exposes it as POST.
  if (!res.ok) throw new Error(`list ${bucket}: HTTP ${res.status}`);
  const entries = await res.json();
  const out = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) out.push(...(await listBucket(base, key, bucket, path)));
    else out.push({ path, size: entry.metadata?.size ?? null, contentType: entry.metadata?.mimetype ?? null, updatedAt: entry.updated_at ?? null });
  }
  return out;
}

function insideRepo(dir) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const rel = relative(repo, resolve(dir));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export async function exportInstance({ base, key, out, instance }) {
  if (insideRepo(out)) throw new Error("--out must be outside the repository: exports hold customer data and are never committed.");
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty. Use a new directory for each export.`);
  mkdirSync(join(out, "tables"), { recursive: true });
  const startedAt = new Date().toISOString();
  const before = {};
  for (const spec of TABLES) before[spec.table] = await count(base, key, spec.table);
  const files = [];
  const tables = [];
  for (const spec of TABLES) {
    const rows = await readTable(base, key, spec);
    if (rows === null) {
      tables.push({ table: spec.table, present: false, rows: 0 });
      continue;
    }
    const body = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
    const file = `tables/${spec.table}.ndjson`;
    writeFileSync(join(out, file), body);
    files.push({ file, bytes: Buffer.byteLength(body), sha256: sha256(body) });
    tables.push({ table: spec.table, present: true, rows: rows.length, stripped: spec.strip ?? [] });
  }
  const objects = [];
  for (const bucket of BUCKETS) {
    let listed = [];
    try {
      listed = await listBucket(base, key, bucket);
    } catch (error) {
      objects.push({ bucket, error: String(error.message ?? error) });
      continue;
    }
    for (const object of listed) {
      const res = await fetch(`${base}/storage/v1/object/${bucket}/${object.path.split("/").map(encodeURIComponent).join("/")}`, { headers: headers(key) });
      if (!res.ok) {
        objects.push({ bucket, path: object.path, error: `HTTP ${res.status}` });
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      const file = `files/${bucket}/${object.path}`;
      mkdirSync(dirname(join(out, file)), { recursive: true });
      writeFileSync(join(out, file), bytes);
      objects.push({ bucket, path: object.path, file, bytes: bytes.length, sha256: sha256(bytes), contentType: object.contentType, updatedAt: object.updatedAt });
    }
  }
  const after = {};
  for (const spec of TABLES) after[spec.table] = await count(base, key, spec.table);
  const moved = Object.keys(after).filter((table) => after[table] !== before[table]);
  const manifest = {
    version: EXPORT_VERSION,
    source: { system: "instant_shine", instance },
    startedAt,
    finishedAt: new Date().toISOString(),
    consistent: moved.length === 0,
    moved,
    tables,
    skipped: SKIPPED,
    files,
    objects,
  };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const base = process.env.INSTANT_SHINE_URL;
  const key = process.env.INSTANT_SHINE_KEY ?? "proxy-injected";
  const out = arg("--out");
  if (!base || !out) {
    console.error("Set INSTANT_SHINE_URL and pass --out <directory outside the repository>.");
    process.exit(2);
  }
  const instance = arg("--instance") ?? new URL(base).hostname.split(".")[0];
  exportInstance({ base: base.replace(/\/$/, ""), key, out, instance })
    .then((m) => {
      console.log(`Exported ${m.tables.filter((t) => t.present).length} tables, ${m.objects.filter((o) => o.file).length} files. Consistent snapshot: ${m.consistent ? "yes" : `no (moved: ${m.moved.join(", ")})`}.`);
    })
    .catch((error) => {
      console.error(String(error.message ?? error));
      process.exit(1);
    });
}
