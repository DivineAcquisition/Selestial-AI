import { describe, expect, it } from "vitest";

import { INTERNAL_BOOKING_PATH, QUOTES_PATH, workspaceHref, workspaceOwner, workspaceReturn, workspaceTitle } from "./sales-workspace";

describe("the Sales workspace's place in the navigation", () => {
  it("belongs to Internal Booking for a booking and to Quotes & Proposals for a proposal", () => {
    expect(workspaceOwner("booking")).toEqual({ agent: "sales", tab: "internal-booking" });
    expect(workspaceOwner("proposal")).toEqual({ agent: "sales", tab: "quotes-proposals" });
    expect(INTERNAL_BOOKING_PATH).toBe("/app/agents/sales/internal-booking");
    expect(QUOTES_PATH).toBe("/app/agents/sales/quotes-proposals");
    expect(workspaceTitle("Dana Whitfield", "booking")).toBe("Dana Whitfield · Internal Booking · Selestial");
  });

  it("returns to where this visit came from, then to where the draft started, then to the draft's own tab", () => {
    expect(workspaceReturn({ mode: "booking", from: "internal-booking" })).toEqual({ href: INTERNAL_BOOKING_PATH, label: "Internal Booking" });
    expect(workspaceReturn({ mode: "booking", from: "quotes" })).toEqual({ href: QUOTES_PATH, label: "Quotes & Proposals" });
    expect(workspaceReturn({ mode: "booking", from: "pipeline" }).href).toBe("/app/agents/sales/pipeline");
    expect(workspaceReturn({ mode: "booking", from: "calendar" }).href).toBe("/app/calendar");
    expect(workspaceReturn({ mode: "booking", from: "dispatch" }).href).toBe("/app/agents/dispatch/schedule");
    expect(workspaceReturn({ mode: "booking", from: "sales-agent" }).href).toBe("/app/agents/sales");
    // A customer's own page when the draft remembers which customer; their list otherwise.
    expect(workspaceReturn({ mode: "booking", entry: { from: "customer", id: "k57abc" } }).href).toBe("/app/clients/k57abc");
    expect(workspaceReturn({ mode: "booking", from: "customer" }).href).toBe("/app/clients");
    // This visit's entry point wins over where the draft was first started.
    expect(workspaceReturn({ mode: "booking", from: "internal-booking", entry: { from: "dispatch" } }).href).toBe(INTERNAL_BOOKING_PATH);
    expect(workspaceReturn({ mode: "booking", entry: { from: "dispatch" } }).href).toBe("/app/agents/dispatch/schedule");
    // Nothing known, or something unknown: the tab the draft belongs to now.
    expect(workspaceReturn({ mode: "booking" }).href).toBe(INTERNAL_BOOKING_PATH);
    expect(workspaceReturn({ mode: "proposal", from: "https://elsewhere.example" }).href).toBe(QUOTES_PATH);
    expect(workspaceReturn({ mode: "proposal", entry: { from: "customer", id: "../../admin" } }).href).toBe("/app/clients");
  });

  it("carries only known entry points in the address", () => {
    expect(workspaceHref("k57abc", "internal-booking")).toBe("/app/agents/sales/book/k57abc?from=internal-booking");
    expect(workspaceHref("k57abc", "javascript:alert(1)")).toBe("/app/agents/sales/book/k57abc");
    expect(workspaceHref("k57abc")).toBe("/app/agents/sales/book/k57abc");
  });
});
