/**
 * @vitest-environment edge-runtime
 *
 * Migration tutorials: only published ones reach an owner, publishing needs the steps followed in a real
 * account, a new media version reaches every screen, reports flag a tutorial for staff, and analytics hold
 * no more than which tutorial, where and what happened.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { company, refusal, start } from "../tests/harness";
import { ADMIN, staffSetup } from "../tests/trustHarness";
import { api } from "./_generated/api";
import { NOT_FOUND } from "./lib/errors";
import { matches, PLACEMENTS, TUTORIALS, tutorialById } from "./lib/tutorials/catalog";
import { SETUP_TUTORIALS } from "./lib/tutorials/setup";

const MEDIA = { version: 2, video: "https://media.example/t/v2.mp4", poster: "https://media.example/t/v2.jpg", captions: "https://media.example/t/v2.vtt", durationSeconds: 84 };

describe("The tutorial catalog", () => {
  it("gives every tutorial a stable id, sources, a check date, steps and a known placement", () => {
    const ids = new Set<string>();
    for (const tutorial of TUTORIALS) {
      expect(ids.has(tutorial.id), tutorial.id).toBe(false);
      ids.add(tutorial.id);
      expect(tutorial.sources.length, tutorial.id).toBeGreaterThan(0);
      expect(tutorial.docsCheckedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(tutorial.steps.length, tutorial.id).toBeGreaterThan(0);
      expect(tutorial.placements.every((placement) => (PLACEMENTS as readonly string[]).includes(placement))).toBe(true);
      // Nothing starts published in a release without the interface checked and the narration reviewed.
      if (tutorial.defaultState === "published") expect(tutorial.interfaceVerifiedOn && tutorial.transcript).toBeTruthy();
      // Every platform export tutorial ends by sending the owner back to Selestial.
      if (tutorial.platform !== "spreadsheet" && tutorial.platform !== "selestial" && tutorial.steps.length > 1) expect(tutorial.steps.at(-1), tutorial.id).toMatch(/Selestial/);
    }
  });

  it("offers only the selected platform's export, and Selestial's own help for errors", () => {
    const jobberClients = tutorialById("jobber-export-clients")!;
    expect(matches(jobberClients, "setup.source", "jobber")).toBe(true);
    expect(matches(jobberClients, "setup.source", "housecall_pro")).toBe(false);
    // Export guidance is never offered for an unrelated validation error.
    expect(TUTORIALS.filter((tutorial) => matches(tutorial, "import.clients.missing_columns", "jobber")).map((tutorial) => tutorial.id)).toEqual(["selestial-fix-import-errors"]);
    expect(matches(tutorialById("spreadsheet-prepare-clients")!, "import.clients.upload", "jobber")).toBe(false);
  });
});

describe("Tutorial publication", () => {
  beforeEach(() => {
    process.env.STAFF_BOOTSTRAP_EMAIL = ADMIN.email;
  });
  afterEach(() => {
    delete process.env.STAFF_BOOTSTRAP_EMAIL;
  });

  it("shows owners only published tutorials, and refuses to publish an unverified one", async () => {
    const t = start();
    const { admin } = await staffSetup(t);
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    expect(await as.query(api.tutorials.published, { companyId })).toEqual([]);

    // Jobber's steps are from its help center but not yet followed in an account.
    await expect(admin.mutation(api.tutorials.setState, { tutorialId: "jobber-export-clients", state: "published" })).rejects.toThrow(/real account/);

    // Verified in Selestial itself, with no video yet: published as written steps, never as an empty player.
    await admin.mutation(api.tutorials.setState, { tutorialId: "spreadsheet-prepare-clients", state: "published" });
    const shown = await as.query(api.tutorials.published, { companyId });
    expect(shown.map((row) => row.id)).toEqual(["spreadsheet-prepare-clients"]);
    expect(shown[0].media).toBeNull();

    // With media and no reviewed transcript, a video is not published.
    await admin.mutation(api.tutorials.setState, { tutorialId: "spreadsheet-prepare-clients", state: "draft" });
    await admin.mutation(api.tutorials.setMedia, { tutorialId: "spreadsheet-prepare-clients", media: MEDIA });
    await expect(admin.mutation(api.tutorials.setState, { tutorialId: "spreadsheet-prepare-clients", state: "published" })).rejects.toThrow(/transcript/);
    await expect(admin.mutation(api.tutorials.setMedia, { tutorialId: "spreadsheet-prepare-clients", media: { ...MEDIA, video: "http://insecure.example/v.mp4" } })).rejects.toThrow(/https/);

    // An owner cannot change publication; staff functions do not even admit they exist.
    expect(await refusal(as.mutation(api.tutorials.setState, { tutorialId: "spreadsheet-prepare-clients", state: "published" }))).toBe(NOT_FOUND);
  });

  it("records use without file contents, and flags a tutorial reported as changed", async () => {
    const t = start();
    const { admin } = await staffSetup(t);
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await admin.mutation(api.tutorials.setState, { tutorialId: "spreadsheet-prepare-clients", state: "published" });

    await as.mutation(api.tutorials.track, { companyId, tutorialId: "spreadsheet-prepare-clients", kind: "opened", placement: "import.clients.upload" });
    await expect(as.mutation(api.tutorials.track, { companyId, tutorialId: "made-up", kind: "opened", placement: "help" })).rejects.toThrow(/catalog/);
    const events = await t.run(async (ctx) => ctx.db.query("tutorialEvents").collect());
    expect(Object.keys(events[0]).sort()).toEqual(["_creationTime", "_id", "at", "companyId", "kind", "placement", "tutorialId"]);

    await as.mutation(api.tutorials.reportOutdated, { companyId, tutorialId: "spreadsheet-prepare-clients", placement: "import.clients.upload", note: "The download menu moved." });
    expect((await as.query(api.tutorials.published, { companyId }))[0].reported).toBe(true);
    const list = await admin.query(api.tutorials.staffList, {});
    const row = list.find((item) => item.id === "spreadsheet-prepare-clients")!;
    expect(row.reports).toHaveLength(1);

    // Needs update takes it away from owners until it is reviewed again.
    await admin.mutation(api.tutorials.setState, { tutorialId: row.id, state: "needs_update" });
    expect(await as.query(api.tutorials.published, { companyId })).toEqual([]);
    await admin.mutation(api.tutorials.resolveReport, { reportId: row.reports[0].id });
    await admin.mutation(api.tutorials.setState, { tutorialId: row.id, state: "published" });
    expect((await as.query(api.tutorials.published, { companyId }))[0].reported).toBe(false);

    const metrics = await admin.query(api.tutorials.metrics, { days: 30 });
    expect(metrics.tutorials.find((item) => item.id === row.id)?.counts).toMatchObject({ opened: 1, reported_outdated: 1 });
  });
});

describe("Setup guides", () => {
  beforeEach(() => {
    process.env.STAFF_BOOTSTRAP_EMAIL = ADMIN.email;
  });
  afterEach(() => {
    delete process.env.STAFF_BOOTSTRAP_EMAIL;
  });

  it("are six ordered guides, each beside its task, with a next step inside the app", () => {
    expect(SETUP_TUTORIALS.map((tutorial) => tutorial.order)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const tutorial of SETUP_TUTORIALS) {
      expect(tutorial.platform, tutorial.id).toBe("selestial");
      expect(TUTORIALS.some((row) => row.id === tutorial.id)).toBe(true);
      // Offered beside the task and in both getting-started lists.
      expect(tutorial.placements, tutorial.id).toEqual(expect.arrayContaining(["help", "home.getting_started"]));
      expect(tutorial.placements.length, tutorial.id).toBeGreaterThan(2);
      // The next step is a screen in Selestial, never a page elsewhere.
      expect(tutorial.action.kind === "open" && tutorial.action.href.startsWith("/app"), tutorial.id).toBe(true);
      // A release never publishes one: staff do, after review.
      expect(tutorial.defaultState, tutorial.id).toBe("draft");
      // A video's words are its transcript: no transcript without the steps having been followed and recorded.
      if (tutorial.transcript) expect(tutorial.interfaceVerifiedOn, tutorial.id).toBeTruthy();
    }
    // Whatever system the owner came from, a setup guide fits.
    expect(matches(tutorialById("setup-company")!, "setup.flow", "jobber")).toBe(true);
  });

  it("say a task is done only from the company's records, never from watching", async () => {
    const t = start();
    const { admin } = await staffSetup(t);
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const done = async () => Object.fromEntries((await as.query(api.tutorials.setupStatus, { companyId })).map((row) => [row.id, row.done]));
    expect(Object.values(await done()).every((value) => value === false)).toBe(true);

    // Watching the whole video changes nothing.
    await admin.mutation(api.tutorials.setMedia, { tutorialId: "setup-company", media: MEDIA });
    await admin.mutation(api.tutorials.setState, { tutorialId: "setup-company", state: "published" });
    for (const kind of ["opened", "play_started", "play_completed", "action_selected"] as const) await as.mutation(api.tutorials.track, { companyId, tutorialId: "setup-company", kind, placement: "settings.business" });
    expect((await done())["setup-company"]).toBe(false);

    // Saving a service area does.
    const business = await as.query(api.settings.business, { companyId });
    await as.mutation(api.settings.saveBusiness, { companyId, expectedRevision: business.revision, name: business.name, timezone: business.timezone, serviceAreas: ["78701"], hours: business.hours, services: business.services });
    expect(await done()).toMatchObject({ "setup-company": true, "setup-services": false, "setup-clients": false });

    // Another company's records never count.
    const other = await company(t, "owner-b", "Beta Cleaning");
    expect((await other.as.query(api.tutorials.setupStatus, { companyId: other.companyId })).every((row) => !row.done)).toBe(true);
    expect(await refusal(other.as.query(api.tutorials.setupStatus, { companyId }))).toBe(NOT_FOUND);
  });

  it("publish with their video only once their transcript is reviewed", async () => {
    const t = start();
    const { admin } = await staffSetup(t);
    // Recorded and reviewed: setup-company carries its transcript.
    await admin.mutation(api.tutorials.setMedia, { tutorialId: "setup-company", media: { ...MEDIA, transcript: "https://media.example/t/v2.txt" } });
    await admin.mutation(api.tutorials.setState, { tutorialId: "setup-company", state: "published" });
    // Not yet recorded and reviewed: refused.
    await admin.mutation(api.tutorials.setMedia, { tutorialId: "setup-agents", media: MEDIA });
    await expect(admin.mutation(api.tutorials.setState, { tutorialId: "setup-agents", state: "published" })).rejects.toThrow();
    // A transcript address must be https or on Selestial's own site.
    await expect(admin.mutation(api.tutorials.setMedia, { tutorialId: "setup-company", media: { ...MEDIA, transcript: "ftp://media.example/t.txt" } })).rejects.toThrow(/https/);
  });
});
