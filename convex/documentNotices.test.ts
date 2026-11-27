/**
 * @vitest-environment edge-runtime
 *
 * The in-product notice about a changed document (convex/trust.ts documentNotices): the reworded Privacy
 * notice of November 27, 2026 is shown to people who already had an account, once each, until they close it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, start } from "../tests/harness";
import { api } from "./_generated/api";
import { noticesDue } from "./lib/trust/documents";

const BEFORE = Date.UTC(2026, 10, 20, 15);
const AFTER = Date.UTC(2026, 10, 28, 15);

describe("changed-document notices", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("tells existing members once each, and not people who joined after the change", async () => {
    const t = start();
    vi.setSystemTime(BEFORE);
    const owner = await company(t, "owner-a", "Alpha Cleaning");
    const manager = await addMember(t, owner.as, owner.companyId, "mgr", "manager");
    vi.setSystemTime(AFTER);
    const late = await addMember(t, owner.as, owner.companyId, "office", "office");
    const shown = await owner.as.query(api.trust.documentNotices, { companyId: owner.companyId });
    expect(shown).toEqual([expect.objectContaining({ documentId: "privacy-2026-11-27", kind: "privacy", title: "Privacy Notice", effectiveOn: "2026-11-27", notice: expect.stringMatching(/stay in its workspace after its plan ends/) })]);
    expect(await manager.query(api.trust.documentNotices, { companyId: owner.companyId })).toHaveLength(1);
    expect(await late.query(api.trust.documentNotices, { companyId: owner.companyId })).toEqual([]);
    // Closing it is remembered for that person only, and closing twice changes nothing.
    await owner.as.mutation(api.trust.dismissDocumentNotice, { companyId: owner.companyId, documentId: "privacy-2026-11-27" });
    await owner.as.mutation(api.trust.dismissDocumentNotice, { companyId: owner.companyId, documentId: "privacy-2026-11-27" });
    expect(await owner.as.query(api.trust.documentNotices, { companyId: owner.companyId })).toEqual([]);
    expect(await manager.query(api.trust.documentNotices, { companyId: owner.companyId })).toHaveLength(1);
    expect(await t.run(async (ctx) => (await ctx.db.query("documentNoticeDismissals").collect()).length)).toBe(1);
  });

  it("is announced only while in force and recent, and only for versions with a notice", () => {
    const published = [{ documentId: "privacy-2026-11-27", status: "published" }];
    expect(noticesDue(published, AFTER).map((row) => row.id)).toEqual(["privacy-2026-11-27"]);
    expect(noticesDue(published, Date.UTC(2026, 10, 26))).toEqual([]);
    expect(noticesDue(published, Date.UTC(2027, 1, 26))).toEqual([]);
    // Withdrawn by staff: not announced.
    expect(noticesDue([{ documentId: "privacy-2026-11-27", status: "withdrawn" }], AFTER)).toEqual([]);
  });
});
