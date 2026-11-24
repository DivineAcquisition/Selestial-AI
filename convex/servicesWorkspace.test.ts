/**
 * The service workspace: Selestial beside one service (stale answers change nothing, its edits can be
 * undone safely), Review & publish in place, and what the workspace reads from onboarding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, NOW, refusal, start, type T } from "../tests/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mockChat } from "./lib/chat/model";
import { blankSpec, type Spec } from "./lib/services/spec";
import { STALE_DRAFT } from "./lib/services/workflow";

const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

function readySpec(patch: Partial<Spec> = {}): Spec {
  return {
    ...blankSpec("residential"),
    name: "Standard clean",
    summary: "A full clean of the living areas, kitchen and bathrooms.",
    included: [{ id: "counters", label: "Wipe kitchen counters", section: "Kitchen", requiresPhoto: false }],
    excluded: ["Inside the oven"],
    pricing: { method: "bed_bath", baseCents: 12000, includedBedrooms: 1, includedBathrooms: 1, perBedroomCents: 2000, perBathroomCents: 2500, perHalfBathCents: 1000, baseLaborMinutes: 120, perBedroomMinutes: 30, perBathroomMinutes: 30, perHalfBathMinutes: 15 },
    ...patch,
  };
}

async function setup() {
  const t = start();
  const owner = await company(t, "owner-a", "Alpha Cleaning");
  const { serviceId } = await owner.as.mutation(api.services.startDraft, { companyId: owner.companyId, category: "residential", spec: readySpec(), origin: "manual" });
  return { t, ...owner, serviceId };
}

const priceEdit = (baseCents: number) => ({ name: "edit_service_draft", input: { service: "Standard clean", changes: { pricing: { method: "bed_bath", baseCents } } } });
const base = (spec: Spec | undefined) => (spec?.pricing.method === "bed_bath" ? spec.pricing.baseCents : null);

describe("the service workspace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockChat.script = [];
    mockChat.seen = [];
    mockChat.onRespond = null;
    process.env.CHAT_MODEL = "mock";
  });
  afterEach(() => {
    vi.useRealTimers();
    mockChat.onRespond = null;
    delete process.env.CHAT_MODEL;
  });

  describe("Selestial beside a service", () => {
    it("keeps its conversation focused on this service, and finds it again for the person who started it", async () => {
      const { t, as, companyId, serviceId } = await setup();
      mockChat.script = [{ text: "It needs nothing else." }];
      const sent = await as.mutation(api.chat.send, { companyId, text: "What's missing?", clientKey: "ws-1", origin: { kind: "service_draft", serviceId }, draftRevision: 1 });
      await settle(t);
      expect(mockChat.seen[0].system).toContain(serviceId);
      expect((await as.query(api.services.assistant, { companyId, serviceId })).conversationId).toBe(sent.conversationId);
      // Conversations are private: a teammate starts their own.
      const manager = await addMember(t, as, companyId, "manager-a", "manager");
      expect((await manager.query(api.services.assistant, { companyId, serviceId })).conversationId).toBeNull();
    });

    it("changes nothing when the draft moved after the person asked, so newer manual edits are kept", async () => {
      const { t, as, companyId, serviceId } = await setup();
      // While Selestial is thinking, the person keeps typing in the editor.
      let typed = false;
      mockChat.onRespond = async () => {
        if (typed) return;
        typed = true;
        await as.mutation(api.services.saveDraft, { companyId, serviceId, expectedRevision: 1, spec: readySpec({ name: "Standard clean", summary: "Typed while waiting." }), step: "basics" });
      };
      mockChat.script = [{ toolCalls: [priceEdit(15000)] }, { text: "I couldn't change it." }];
      await as.mutation(api.chat.send, { companyId, text: "Make the base $150.", clientKey: "ws-2", origin: { kind: "service_draft", serviceId }, draftRevision: 1 });
      await settle(t);
      const view = await as.query(api.services.service, { companyId, serviceId });
      expect(view.draft?.revision).toBe(2);
      expect(view.draft?.spec.summary).toBe("Typed while waiting.");
      expect(base(view.draft?.spec)).toBe(12000);
      expect(await as.query(api.services.draftEdits, { companyId, serviceId })).toEqual([]);
      // The model was told why, in words it can pass on.
      expect(JSON.stringify(mockChat.seen[1].messages)).toContain("changed after you asked");
    });

    it("counts its own earlier edits in the same answer as the person's request, and records each", async () => {
      const { t, as, companyId, serviceId } = await setup();
      mockChat.script = [{ toolCalls: [priceEdit(14000)] }, { toolCalls: [{ name: "edit_service_draft", input: { service: "Standard clean", changes: { addIncluded: [{ label: "Inside the microwave", section: "Kitchen" }] } } }] }, { text: "Done." }];
      await as.mutation(api.chat.send, { companyId, text: "Base $140 and add the microwave.", clientKey: "ws-3", origin: { kind: "service_draft", serviceId }, draftRevision: 1 });
      await settle(t);
      const view = await as.query(api.services.service, { companyId, serviceId });
      expect(view.draft?.revision).toBe(3);
      expect(base(view.draft?.spec)).toBe(14000);
      const edits = await as.query(api.services.draftEdits, { companyId, serviceId });
      expect(edits.map((e) => e.parts)).toEqual([["Included tasks"], ["Price"]]);
      expect(edits.every((e) => e.canUndo)).toBe(true);
    });

    it("undoes only what still holds Selestial's value, and names what it kept", async () => {
      const { t, as, companyId, serviceId } = await setup();
      mockChat.script = [{ toolCalls: [{ name: "edit_service_draft", input: { service: "Standard clean", changes: { summary: "Selestial's words.", pricing: { method: "bed_bath", baseCents: 16000 } } } }] }, { text: "Done." }];
      await as.mutation(api.chat.send, { companyId, text: "Rewrite the description and make the base $160.", clientKey: "ws-4", origin: { kind: "service_draft", serviceId }, draftRevision: 1 });
      await settle(t);
      // The person then rewrites the description themselves.
      const now = await as.query(api.services.service, { companyId, serviceId });
      await as.mutation(api.services.saveDraft, { companyId, serviceId, expectedRevision: now.draft!.revision, spec: { ...now.draft!.spec, summary: "My own words." }, step: "basics" });
      const [edit] = await as.query(api.services.draftEdits, { companyId, serviceId });
      expect(edit.keptIfUndone).toEqual(["Description"]);
      await as.mutation(api.services.undoEdit, { companyId, editId: edit.id });
      const after = await as.query(api.services.service, { companyId, serviceId });
      expect(base(after.draft?.spec)).toBe(12000);
      expect(after.draft?.spec.summary).toBe("My own words.");
      const [undone] = await as.query(api.services.draftEdits, { companyId, serviceId });
      expect(undone.undone?.kept).toEqual(["Description"]);
      expect(undone.canUndo).toBe(false);
      // A second undo (a double tap) changes nothing.
      expect(await as.mutation(api.services.undoEdit, { companyId, editId: edit.id })).toMatchObject({ reverted: [], revision: null });
      expect((await as.query(api.services.service, { companyId, serviceId })).draft?.revision).toBe(after.draft?.revision);
    });

    it("lets Office read Selestial's edits but not undo them", async () => {
      const { t, as, companyId, serviceId } = await setup();
      mockChat.script = [{ toolCalls: [priceEdit(15000)] }, { text: "Done." }];
      await as.mutation(api.chat.send, { companyId, text: "Base $150.", clientKey: "ws-5", origin: { kind: "service_draft", serviceId }, draftRevision: 1 });
      await settle(t);
      const office = await addMember(t, as, companyId, "office-a", "office");
      const [edit] = await office.query(api.services.draftEdits, { companyId, serviceId });
      expect(edit.canUndo).toBe(false);
      expect(await refusal(office.mutation(api.services.undoEdit, { companyId, editId: edit.id }))).not.toBe("");
    });
  });

  describe("Review & publish in place", () => {
    it("reads what publishing does from the saved draft, honestly", async () => {
      const { as, companyId, serviceId } = await setup();
      const review = await as.query(api.services.reviewPreview, { companyId, serviceId });
      expect(review.draft).toMatchObject({ revision: 1, sameAsLive: false, blockers: [] });
      expect(review.draft?.impact.join(" ")).toContain("No booking form offers it yet");
      expect(review.draft?.impact.join(" ")).toContain("Publishing a service never publishes a booking form");
      expect(review.draft?.impact.join(" ")).toContain("Sent and accepted proposals keep their prices");
      expect(review.draft?.impact.join(" ")).not.toMatch(/forever|always keep/i);
      expect(review).toMatchObject({ canPublish: true, canSubmit: true, forms: [], openChange: null });
    });

    it("publishes exactly the revision the Owner reviewed, once, and refuses a Manager", async () => {
      const { t, as, companyId, serviceId } = await setup();
      const manager = await addMember(t, as, companyId, "manager-a", "manager");
      expect((await manager.query(api.services.reviewPreview, { companyId, serviceId })).canPublish).toBe(false);
      expect(await refusal(manager.mutation(api.services.publishDraft, { companyId, serviceId, expectedRevision: 1, reason: "Launch." }))).not.toBe("");
      // A screen behind the draft can't publish what it didn't show.
      await as.mutation(api.services.saveDraft, { companyId, serviceId, expectedRevision: 1, spec: readySpec({ summary: "Newer words." }), step: "basics" });
      expect(await refusal(as.mutation(api.services.publishDraft, { companyId, serviceId, expectedRevision: 1, reason: "Launch." }))).toBe(STALE_DRAFT);
      expect((await as.query(api.services.service, { companyId, serviceId })).live).toBeNull();
      const first = await as.mutation(api.services.publishDraft, { companyId, serviceId, expectedRevision: 2, reason: "Launch." });
      expect(first).toEqual({ state: "published", version: 1 });
      const view = await as.query(api.services.service, { companyId, serviceId });
      expect(view.live?.version).toBe(1);
      expect(view.live?.spec.summary).toBe("Newer words.");
      // A retry (a double tap, a lost response) finds nothing to publish and changes nothing.
      expect(await as.mutation(api.services.publishDraft, { companyId, serviceId, expectedRevision: 2, reason: "Launch." })).toEqual({ state: "nothing", version: 1 });
      const changes = (await as.query(api.services.changes, { companyId })).changes;
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ state: "published", version: 1 });
    });

    it("won't publish a draft that still has example prices", async () => {
      const t = start();
      const { as, companyId } = await company(t, "owner-b", "Beta Cleaning");
      const { serviceId } = await as.mutation(api.services.startDraft, { companyId, category: "residential", spec: readySpec({ illustrative: true }), origin: "template" });
      const review = await as.query(api.services.reviewPreview, { companyId, serviceId });
      expect(review.draft?.blockers.length).toBeGreaterThan(0);
      expect(await refusal(as.mutation(api.services.publishDraft, { companyId, serviceId, expectedRevision: 1, reason: "Launch." }))).toContain("Not ready for review");
    });

    it("keeps each company's review to itself", async () => {
      const { t, serviceId } = await setup();
      const other = await company(t, "owner-c", "Gamma Cleaning");
      expect(await refusal(other.as.query(api.services.reviewPreview, { companyId: other.companyId, serviceId }))).toBe("Not found.");
      expect(await refusal(other.as.mutation(api.services.publishDraft, { companyId: other.companyId, serviceId, expectedRevision: 1, reason: "x" }))).toBe("Not found.");
    });
  });

  describe("what the workspace reads", () => {
    it("says plainly what onboarding hasn't told it yet", async () => {
      const { as, companyId } = await setup();
      const known = await as.query(api.services.startingPoint, { companyId });
      expect(known.known.map((k) => k.provenance)).toEqual(["unknown", "unknown", "unknown"]);
      expect(known).toMatchObject({ costs: "unknown", pricing: null, canConfigure: true });
    });

    it("gives each card a price only when one is set, and how customers get it", async () => {
      const { as, companyId, serviceId } = await setup();
      const { serviceId: empty } = await as.mutation(api.services.startDraft, { companyId, category: "residential", spec: { ...blankSpec("residential"), name: "Deep clean" }, origin: "manual" });
      const rows = (await as.query(api.services.catalog, { companyId })).services;
      const ready = rows.find((r) => r.id === serviceId)!;
      const blank = rows.find((r) => r.id === (empty as Id<"services">))!;
      expect(ready.draft).toMatchObject({ priced: true, blockers: 0, firstBlocker: null, changed: false });
      expect(blank.draft?.priced).toBe(false);
      expect(ready.booking).toEqual({ estimate: false, liveForms: 0, forms: 0 });
      expect(ready.prepared).toBe(false);
    });
  });
});
