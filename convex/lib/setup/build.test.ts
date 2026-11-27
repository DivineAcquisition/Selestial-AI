import { describe, expect, it } from "vitest";

import { buildPlan, buildSentence, fromCard, fromTask, leadHeadline, ordered, summarize, type BuildItem } from "./build";

const card = (kind: "services" | "booking", status: Parameters<typeof fromCard>[0]["status"], items = 1) => fromCard({ kind, status, items: Array.from({ length: items }, (_, i) => ({ label: `${kind} ${i}`, href: `/app/${kind}/${i}`, status: "ready", detail: "Draft", flags: [] })), missing: status === "needs_info" ? [{ words: "Add your ZIP codes.", href: "/app/setup/business#availability" }] : [], error: status === "failed" ? "It broke." : null });
const task = (template: string, state: Parameters<typeof fromTask>[0]["state"], outputs = 0) =>
  fromTask({ id: template, template, agent: "sales", title: template, state, statusLine: "Working.", outputs: Array.from({ length: outputs }, (_, i) => ({ kind: "x", ref: { label: `out ${i}`, href: `/app/x/${i}` }, state: "draft" })), blocker: state === "waiting_info" ? { kind: "information", words: "Add a job.", action: { label: "Add a job", href: "/app/schedule" } } : null });

describe("One honest picture of Build", () => {
  it("counts each state once and never counts failed or waiting work as prepared", () => {
    const items = [card("services", "failed")!, card("booking", "needs_info")!, task("sales.faq_answers", "ready_for_review", 2), task("dispatch.coverage_review", "waiting_info"), task("recruiter.role_draft", "working"), task("retention.care_setup", "completed", 0)];
    const counts = summarize(items);
    expect(counts).toEqual({ total: 6, preparing: 1, ready: 1, needsInput: 2, waitingConnection: 0, failed: 1, published: 0, notAvailable: 0, usable: 1 });
    // Published only when the record is.
    expect(card("services", "published")!.state).toBe("published");
    expect(task("sales.booking_page", "completed", 1).state).toBe("ready");
    expect(card("services", "not_started")).toBeNull();
  });

  it("leads with the outcome's own usable work, and never lets a failure hide a ready result", () => {
    const items: BuildItem[] = [card("services", "failed")!, card("booking", "ready")!, task("sales.faq_answers", "ready_for_review", 1)];
    const { lead, rest } = ordered("sales", items);
    expect(lead?.key).toBe("configure:booking");
    expect(rest.map((item) => item.key)).toEqual(["activation:sales.faq_answers", "configure:services"]);
    expect(leadHeadline("sales", lead)).toBe("Your booking form draft is ready");
    expect(leadHeadline("dispatch", ordered("dispatch", [task("dispatch.coverage_review", "waiting_info"), task("dispatch.readiness", "completed", 1)]).lead)).toBe("Your dispatch setup is ready");
    expect(leadHeadline("sales", null)).toBe("Your workspace is being prepared");
  });

  it("plans only what each outcome needs, and never makes the same draft through two workers", () => {
    expect(buildPlan("sales", true)).toEqual({ configure: ["services", "booking"], exclude: ["sales.service_draft", "sales.booking_page"] });
    expect(buildPlan("dispatch", true)).toEqual({ configure: [], exclude: [] });
    // Without categories configuration can't choose services; activation's own drafts are used instead.
    expect(buildPlan("pricing", false)).toEqual({ configure: [], exclude: [] });
    expect(buildSentence("recruiter", buildPlan("recruiter", true), ["Draft your hiring role"])).toBe("We'll prepare your first hiring role draft using the details you confirmed.");
  });
});
