/**
 * Sales › Internal Booking: the booking drafts list, and starting a draft from it. The workspace, pricing,
 * quotes and proposals are unchanged; these tests check that the reorganization adds no second record, makes
 * nothing by being opened, and keeps each company's drafts its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, NOW, refusal, start } from "../tests/harness";
import { homeSpec, publish } from "../tests/salesHarness";
import { api } from "./_generated/api";
import { NOT_FOUND } from "./lib/errors";

const PAGE = { numItems: 20, cursor: null };

describe("Internal Booking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  async function setup() {
    const t = start();
    const owner = await company(t, "owner-a", "Alpha Cleaning");
    const key = await publish(owner.as, owner.companyId, homeSpec());
    const count = () => owner.as.query(api.sales.drafts, { companyId: owner.companyId }).then((rows) => rows.length);
    return { t, ...owner, key, count };
  }

  it("lists booking drafts only, with customer, property, service, kind and status, and makes nothing by being read", async () => {
    const { as, companyId, key, count } = await setup();
    expect((await as.query(api.sales.bookingDrafts, { companyId, show: "active", paginationOpts: PAGE })).page).toEqual([]);
    expect(await count()).toBe(0);

    const oneTime = await as.mutation(api.sales.startDraft, { companyId, mode: "booking", from: "internal-booking" });
    vi.setSystemTime(NOW + 60_000);
    const recurring = await as.mutation(api.sales.startDraft, { companyId, mode: "booking", bookingKind: "recurring", from: "internal-booking" });
    vi.setSystemTime(NOW + 120_000);
    const proposal = await as.mutation(api.sales.startDraft, { companyId, mode: "proposal", segment: "commercial", from: "quotes" });
    const riya = await as.mutation(api.sales.quickCreate, { companyId, draftId: recurring, customer: { name: "Riya Shah", phone: "512-555-0100" }, property: { address: { line1: "4 Oak Ave", city: "Austin", region: "TX", postalCode: "78702" } }, confirmedNew: false });
    if (!riya.created) throw new Error("expected a new customer");
    const draft = await as.query(api.sales.draft, { companyId, draftId: recurring });
    await as.mutation(api.sales.saveDraft, { companyId, draftId: recurring, revision: draft.draft.revision, customerId: riya.customerId, propertyId: riya.propertyId, body: { service: { key, input: { bedrooms: 2, bathrooms: 1 } }, recurring: { cadence: { kind: "every_2_weeks", weekday: 2 }, billing: "per_visit" }, payment: { policy: "after_service" } } });

    const before = await count();
    const listed = await as.query(api.sales.bookingDrafts, { companyId, show: "active", paginationOpts: PAGE });
    expect(await count()).toBe(before);
    expect(listed.page.map((row) => row._id)).toEqual([recurring, oneTime]);
    expect(listed.page.map((row) => row._id)).not.toContain(proposal);
    expect(listed.page[0]).toMatchObject({ label: "Riya Shah", property: "4 Oak Ave, Austin", service: "Standard clean", kind: "recurring", status: "open", statusWords: "Draft" });
    expect(listed.page[1]).toMatchObject({ label: null, property: null, service: null, kind: "one_time" });
    // The proposal draft stays where proposals are prepared.
    const all = await as.query(api.sales.drafts, { companyId });
    expect(all.find((row) => row._id === proposal)).toMatchObject({ mode: "proposal" });

    // A quote saved from the booking is one record: listed under Quotes & Proposals, and the draft says it is quoted.
    const latest = await as.query(api.sales.draft, { companyId, draftId: recurring });
    const saved = await as.mutation(api.sales.saveQuoteFromDraft, { companyId, draftId: recurring, revision: latest.draft.revision });
    const quotes = await as.query(api.sales.quotes, { companyId });
    expect(quotes.filter((q) => q.draftId === recurring).map((q) => q._id)).toEqual([saved.quoteId]);
    const quoted = (await as.query(api.sales.bookingDrafts, { companyId, show: "active", paginationOpts: PAGE })).page.find((row) => row._id === recurring);
    expect(quoted).toMatchObject({ status: "quoted", statusWords: "Quote saved", quoteId: saved.quoteId });
    // Nothing is booked yet, so nothing is under Booked.
    expect((await as.query(api.sales.bookingDrafts, { companyId, show: "booked", paginationOpts: PAGE })).page).toEqual([]);

    // A booking switched to a proposal moves to Quotes & Proposals, keeping its id and answers.
    const now = await as.query(api.sales.draft, { companyId, draftId: oneTime });
    await as.mutation(api.sales.saveDraft, { companyId, draftId: oneTime, revision: now.draft.revision, mode: "proposal", segment: "office", body: { notes: { office: "kept" } } });
    expect((await as.query(api.sales.bookingDrafts, { companyId, show: "all", paginationOpts: PAGE })).page.map((row) => row._id)).toEqual([recurring]);
    expect((await as.query(api.sales.draft, { companyId, draftId: oneTime })).draft).toMatchObject({ _id: oneTime, mode: "proposal", body: { notes: { office: "kept" } } });
  });

  it("makes one draft for one click, however many times it is asked, and the right kind of draft", async () => {
    const { t, as, companyId, count } = await setup();
    const first = await as.mutation(api.sales.startDraft, { companyId, mode: "booking", bookingKind: "recurring", from: "internal-booking", clientKey: "click-1" });
    const again = await as.mutation(api.sales.startDraft, { companyId, mode: "booking", bookingKind: "recurring", from: "internal-booking", clientKey: "click-1" });
    expect(again).toBe(first);
    expect(await count()).toBe(1);
    expect((await as.query(api.sales.draft, { companyId, draftId: first })).draft).toMatchObject({ mode: "booking", bookingKind: "recurring", entry: { from: "internal-booking" } });
    // A new click is a new draft; so is the same key from someone else.
    const second = await as.mutation(api.sales.startDraft, { companyId, mode: "booking", from: "internal-booking", clientKey: "click-2" });
    expect(second).not.toBe(first);
    expect((await as.query(api.sales.draft, { companyId, draftId: second })).draft.bookingKind).toBe("one_time");
    const manager = await addMember(t, as, companyId, "manager-a", "manager");
    const theirs = await manager.mutation(api.sales.startDraft, { companyId, mode: "booking", clientKey: "click-1" });
    expect(theirs).not.toBe(first);
    expect(await count()).toBe(3);
  });

  it("keeps each company's booking drafts its own", async () => {
    const { t, as, companyId } = await setup();
    await as.mutation(api.sales.startDraft, { companyId, mode: "booking", clientKey: "shared-key" });
    const other = await company(t, "owner-b", "Beta Cleaning");
    expect((await other.as.query(api.sales.bookingDrafts, { companyId: other.companyId, show: "all", paginationOpts: PAGE })).page).toEqual([]);
    // Another company's id is refused, whoever asks; the same key in another company makes its own draft.
    expect(await refusal(other.as.query(api.sales.bookingDrafts, { companyId, show: "all", paginationOpts: PAGE }))).toBe(NOT_FOUND);
    const theirs = await other.as.mutation(api.sales.startDraft, { companyId: other.companyId, mode: "booking", clientKey: "shared-key" });
    expect((await other.as.query(api.sales.bookingDrafts, { companyId: other.companyId, show: "all", paginationOpts: PAGE })).page.map((row) => row._id)).toEqual([theirs]);
    expect((await as.query(api.sales.bookingDrafts, { companyId, show: "all", paginationOpts: PAGE })).page).toHaveLength(1);
  });
});
