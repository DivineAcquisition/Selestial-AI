/**
 * @vitest-environment edge-runtime
 *
 * Google Drive: a completed visit's photos and a signed agreement are saved to the Owner's chosen folder once
 * each; a test backend never writes them; a knowledge source is read as soon as it is confirmed; and an
 * agreement can be saved as a Google Doc by the people who may export it. Every Google call is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, JOB_START, NOW, refusal, seedVisit, start, type T } from "../tests/harness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { SCOPE } from "./lib/google/features";
import { NOT_RUN_ON_TEST } from "./lib/google/http";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const ENV = { GOOGLE_CLIENT_ID: "client-id.apps.test", GOOGLE_CLIENT_SECRET: "client-secret-not-real", MAILBOX_TOKEN_KEY: KEY, CONVEX_SITE_URL: "https://deployment.convex.site.test", APP_ORIGIN: "https://app.selestial.test" };
const TEST_BACKEND = "https://terrific-avocet-835.convex.cloud";
const b64url = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fakeDrive(files: Record<string, { mimeType: string }> = {}) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "access-1", refresh_token: "refresh-1", scope: `openid email ${SCOPE.driveFile}`, expires_in: 3600, id_token: `${b64url({ alg: "none" })}.${b64url({ sub: "sub-1", email: "owner@alpha.test" })}.sig` });
      if (url.includes("/upload/drive/v3/files")) return json({ id: "new-file", name: "x", mimeType: "image/jpeg", webViewLink: "https://drive.google.com/file/d/new-file" });
      if (url.includes("/drive/v3/files?q=")) return json({ files: [] });
      const id = /\/drive\/v3\/files\/([^/?]+)/.exec(url)?.[1];
      if (id && files[id]) return url.includes("export") || url.includes("alt=media") ? new Response("Our prices: $120 a visit.", { status: 200 }) : json({ id, name: `${id}.doc`, mimeType: files[id].mimeType, capabilities: { canDownload: true, canAddChildren: true } });
      return new Response(JSON.stringify({ error: "not faked" }), { status: 404 });
    }),
  );
  return calls;
}

async function connectDrive(t: T, as: ReturnType<T["withIdentity"]>, companyId: Id<"companies">) {
  const { url } = await as.mutation(api.google.startConnect, { companyId, feature: "drive" });
  fakeDrive();
  const response = await t.fetch(`/oauth/google/callback?state=${encodeURIComponent(new URL(url).searchParams.get("state")!)}&code=c`, { method: "GET" });
  await as.mutation(api.google.confirmConnect, { companyId, token: new URL(response.headers.get("location")!).searchParams.get("pending")! });
  return t.run(async (ctx) => (await ctx.db.query("googleConnections").collect())[0]._id);
}

async function folder(t: T, companyId: Id<"companies">, connectionId: Id<"googleConnections">, purpose: string) {
  return t.run(async (ctx) => {
    const connection = (await ctx.db.get(connectionId))!;
    return ctx.db.insert("googleResources", { companyId, connectionId, kind: "drive_output", externalId: `folder-${purpose}`, label: `${purpose} folder`, purpose, access: "verified", addedBy: connection.connectedBy, createdAt: Date.now() });
  });
}

/** A visit underway with two photos from its cleaner. */
async function visitWithPhotos(t: T, as: ReturnType<T["withIdentity"]>, companyId: Id<"companies">) {
  const { jobId, cleanerId } = await seedVisit(as, companyId);
  await t.run(async (ctx) => {
    const assignmentId = await ctx.db.insert("assignments", { companyId, jobId, cleanerId, status: "accepted", scope: "all", payCents: 5000, offeredAt: NOW, respondBy: NOW + 3_600_000 });
    for (const kind of ["before", "after"] as const) {
      const storageId = await ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
      await ctx.db.insert("evidence", { companyId, jobId, assignmentId, cleanerId, kind, storageId, clientKey: kind, uploadedAt: JOB_START });
    }
    await ctx.db.patch(jobId, { status: "in_progress" });
  });
  return jobId;
}

const uploads = (t: T) => t.run(async (ctx) => (await ctx.db.query("googleJobs").collect()).filter((job) => job.kind === "drive_upload"));

describe("Google Drive", () => {
  let t: T;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    t = start();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("saves a completed visit's photos to the photos folder, once each", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const connectionId = await connectDrive(t, as, companyId);
    const photos = await folder(t, companyId, connectionId, "photos");
    const jobId = await visitWithPhotos(t, as, companyId);
    await as.mutation(api.jobs.closeWithoutReview, { companyId, jobId, reason: "Closed by hand for the Drive test." });
    const queued = await uploads(t);
    expect(queued).toHaveLength(2);
    expect(queued.every((job) => JSON.parse(job.payload).resourceId === photos && job.key.startsWith("drive_upload:evidence:"))).toBe(true);
    // Run one: the file is looked up by its key, then uploaded into the chosen folder.
    const calls = fakeDrive();
    await t.run((ctx) => ctx.db.patch(queued[0]._id, { status: "running", attempts: 1 }));
    await t.action(internal.googleWork.run, { jobId: queued[0]._id });
    expect((await t.run((ctx) => ctx.db.get(queued[0]._id)))!.status).toBe("done");
    expect(calls.filter((call) => call.url.includes("/upload/drive/v3/files") && call.method === "POST")).toHaveLength(1);
  });

  it("saves nothing when no folder is chosen, or Drive is not connected", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const jobId = await visitWithPhotos(t, as, companyId);
    await as.mutation(api.jobs.closeWithoutReview, { companyId, jobId, reason: "Closed by hand for the Drive test." });
    expect(await uploads(t)).toEqual([]);
    const other = await company(t, "owner2", "Bravo");
    await connectDrive(t, other.as, other.companyId);
    const second = await visitWithPhotos(t, other.as, other.companyId);
    await other.as.mutation(api.jobs.closeWithoutReview, { companyId: other.companyId, jobId: second, reason: "Closed by hand for the Drive test." });
    expect(await uploads(t)).toEqual([]);
  });

  it("a backend that is not production never writes the photo to Drive", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const connectionId = await connectDrive(t, as, companyId);
    await folder(t, companyId, connectionId, "photos");
    const jobId = await visitWithPhotos(t, as, companyId);
    await as.mutation(api.jobs.closeWithoutReview, { companyId, jobId, reason: "Closed by hand for the Drive test." });
    const [job] = await uploads(t);
    vi.stubEnv("CONVEX_CLOUD_URL", TEST_BACKEND);
    const calls = fakeDrive();
    await t.run((ctx) => ctx.db.patch(job._id, { status: "running", attempts: 1 }));
    await t.action(internal.googleWork.run, { jobId: job._id });
    expect(await t.run((ctx) => ctx.db.get(job._id))).toMatchObject({ status: "cancelled", lastError: NOT_RUN_ON_TEST });
    expect(calls.some((call) => call.method === "POST" && call.url.includes("/upload/"))).toBe(false);
  });

  it("saves a signed agreement's copy to the agreements folder once", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const connectionId = await connectDrive(t, as, companyId);
    const agreements = await folder(t, companyId, connectionId, "agreements");
    const { requestId, storageId, again } = await t.run(async (ctx) => {
      const member = (await ctx.db.query("members").collect()).find((m) => m.companyId === companyId)!;
      const agreementId = await ctx.db.insert("agreements", { companyId, title: "Service agreement", docType: "commercial_service", category: "customer", access: "company", workflow: "sent", lifecycle: {}, currentVersion: 1, terms: {}, skipped: [], assumptions: [], sources: {}, parties: [], kit: { clauses: [] }, origin: "manual", provenance: "unsigned", searchText: "service", createdBy: member._id, createdAt: Date.now(), updatedAt: Date.now() });
      const requestId = await ctx.db.insert("agreementSignatureRequests", { companyId, agreementId, version: 1, hash: "h", provider: "test", status: "completed", signers: [], expiresAt: Date.now() + 86_400_000, sentBy: member._id, createdAt: Date.now(), reminders: 0 });
      const pdf = () => ctx.storage.store(new Blob(["%PDF-1.4"], { type: "application/pdf" }));
      return { requestId, storageId: await pdf(), again: await pdf() };
    });
    await t.mutation(internal.agreementSigning.saveSigned, { requestId, storageId, hash: "x" });
    // The provider answering twice keeps one copy and saves it to Drive once.
    await t.mutation(internal.agreementSigning.saveSigned, { requestId, storageId: again, hash: "x" });
    const queued = await uploads(t);
    expect(queued).toHaveLength(1);
    expect(queued[0].key).toBe(`drive_upload:signed:${requestId}:folder-agreements`);
    expect(JSON.parse(queued[0].payload)).toMatchObject({ resourceId: agreements, storageId, name: "Service agreement (signed, v1).pdf" });
  });

  it("reads a knowledge source as soon as it is confirmed, without waiting for Refresh", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connectDrive(t, as, companyId);
    const resourceId = await as.mutation(api.google.addResource, { companyId, kind: "drive_source", externalId: "prices-doc-0001", label: "Prices" });
    expect((await as.query(api.googleDrive.sources, { companyId }))[0]).toMatchObject({ reading: true });
    fakeDrive({ "prices-doc-0001": { mimeType: "application/vnd.google-apps.document" } });
    await t.action(internal.googleWork.verifyResource, { resourceId });
    const reads = await t.run(async (ctx) => (await ctx.db.query("googleJobs").collect()).filter((job) => job.kind === "knowledge_import"));
    expect(reads).toHaveLength(1);
    expect((await as.query(api.googleDrive.sources, { companyId }))[0]).toMatchObject({ reading: true, access: "verified" });
    await t.run((ctx) => ctx.db.patch(reads[0]._id, { status: "running", attempts: 1 }));
    await t.action(internal.googleWork.run, { jobId: reads[0]._id });
    const [source] = await as.query(api.googleDrive.sources, { companyId });
    expect(source.reading).toBe(false);
    expect(source.files.map((f) => f.name)).toEqual(["prices-doc-0001.doc"]);
  });

  it("says whether an agreement can be saved as a Google Doc, and only people who may export can save one", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    expect(await as.query(api.googleDrive.docExportReady, { companyId })).toEqual({ connected: false, folder: null });
    const connectionId = await connectDrive(t, as, companyId);
    expect(await as.query(api.googleDrive.docExportReady, { companyId })).toEqual({ connected: true, folder: null });
    await folder(t, companyId, connectionId, "agreements");
    expect(await as.query(api.googleDrive.docExportReady, { companyId })).toEqual({ connected: true, folder: "agreements folder" });
    const office = await addMember(t, as, companyId, "office", "office");
    expect(await refusal(office.mutation(api.googleDrive.exportAgreement, { companyId, agreementId: "missing" }))).toBeTruthy();
  });
});
