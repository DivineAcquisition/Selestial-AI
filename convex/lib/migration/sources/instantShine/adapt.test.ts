import { describe, expect, it } from "vitest";

import { SKIPPED, TABLES } from "../../../../../scripts/migration/instant-shine/export.mjs";
import { adaptInstantShine, realEmail, realPhone, slotMinutes } from "./adapt";
import { CATALOG, CATALOG_BY_TABLE } from "./catalog";
import { FIXTURE, INSTANCE, TODAY } from "./fixtures";

const adapted = () => adaptInstantShine(FIXTURE, { today: TODAY });
const fileOf = (kind: string) => adapted().files.find((f) => f.kind === kind)!;
const valuesOf = (kind: string) => {
  const file = fileOf(kind);
  return file.rows.map((row) => Object.fromEntries(file.header.map((key, i) => [key, row.cells[i]])));
};

describe("the Instant Shine catalog", () => {
  it("gives every table the exporter reads or skips a disposition, and nothing else", () => {
    const exported = [...TABLES.map((t: { table: string }) => t.table), ...Object.keys(SKIPPED)].sort();
    expect(CATALOG.map((e) => e.table).sort()).toEqual(exported);
    for (const entry of CATALOG) expect(entry.why.length).toBeGreaterThan(10);
  });
});

describe("the Instant Shine adapter", () => {
  it("accounts for every source row exactly once, in every table", () => {
    const result = adapted();
    for (const row of result.reconciliation) expect(row, row.table).toMatchObject({ balanced: true });
    expect(result.reconciliation.map((r) => r.table).sort()).toEqual(Object.keys(FIXTURE.tables).sort());
  });

  it("is deterministic, so staging the same snapshot twice stages the same rows", () => {
    expect(JSON.stringify(adapted())).toBe(JSON.stringify(adapted()));
  });

  it("namespaces every id by instance and table, so two tables never share an identity", () => {
    const ids = adapted().files.flatMap((f) => f.rows.map((r) => r.sourceId));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith(`${INSTANCE}/`)).toBe(true);
    // A recurring client is a customer and a plan, under different tables, never the same key.
    const customers = valuesOf("customers").map((v) => v.externalId);
    const plans = valuesOf("recurring").map((v) => v.externalId);
    expect(customers.some((c) => c.includes("/payroll_recurring_clients/"))).toBe(true);
    expect(plans.every((p) => p.includes("/payroll_recurring_clients:plan/"))).toBe(true);
  });

  it("imports each cleaner once, with both source references, and never uses placeholder contact values", () => {
    const cleaners = valuesOf("cleaners");
    expect(cleaners.map((c) => `${c.firstName} ${c.lastName}`).sort()).toEqual(["Dee Lane", "Eli Moss"]);
    const dee = cleaners.find((c) => c.firstName === "Dee")!;
    expect(dee.notes).toMatch(/payroll contractor .* and directory subcontractor/);
    expect(dee.engagement).toBe("contractor");
    const eli = cleaners.find((c) => c.firstName === "Eli")!;
    expect(eli.email).toBe("");
    expect(eli.phone).toBe("");
    const records = adapted().records;
    expect(records.filter((r) => r.table === "subcontractors" && r.outcome === "merged")).toHaveLength(2);
    // The directory-only company address is held back for the Owner, not imported as a cleaner.
    expect(adapted().flags.heldBack.map((h) => h.label)).toContain("Office Owner");
  });

  it("keeps people who share a phone apart, and applies a text opt-out to the matching customer", () => {
    const customers = valuesOf("customers");
    const ortiz = customers.filter((c) => c.lastName === "Ortiz");
    expect(ortiz).toHaveLength(2);
    for (const c of ortiz) expect(c.notes).toMatch(/shared with another customer/);
    expect(customers.find((c) => c.firstName === "Ana")!.smsOptOut).toBe("yes");
    expect(customers.find((c) => c.firstName === "Ben")!.smsOptOut).toBe("");
    expect(adapted().records.find((r) => r.table === "sms_opt_outs")!.outcome).toBe("merged");
  });

  it("holds back an obvious test record, with the reason, instead of dropping it", () => {
    const result = adapted();
    expect(valuesOf("customers").some((c) => c.firstName === "Test")).toBe(false);
    expect(result.flags.heldBack.find((h) => h.label === "Test Booking")!.why).toMatch(/test/);
    // The Owner can include it.
    const included = adaptInstantShine(FIXTURE, { today: TODAY, include: [`${INSTANCE}/customers/00000000-0000-4000-8000-000000000004`] });
    expect(included.files.find((f) => f.kind === "customers")!.rows.some((r) => r.sourceId.endsWith("000000000004"))).toBe(true);
  });

  it("keeps the exact cadence, waits for a next visit instead of inventing one, and never plans an ended service", () => {
    const plans = valuesOf("recurring");
    const fran = plans.find((p) => p.customerName === "Fran Hale")!;
    expect(fran).toMatchObject({ frequency: "once a month", nextVisit: "", time: "", price: "180.00", durationMinutes: "180", status: "active" });
    expect(fran.notes).toMatch(/Usually on Wednesday/);
    expect(plans.find((p) => p.customerName === "Gus Park")).toMatchObject({ frequency: "every 2 weeks", status: "paused" });
    // "custom" is passed through for the check to refuse, never guessed.
    expect(plans.find((p) => p.customerName === "Hal Ward")!.frequency).toBe("custom");
    expect(plans.some((p) => p.customerName === "Ida Fox")).toBe(false);
    expect(valuesOf("customers").some((c) => c.name === "Ida Fox" || c.firstName === "Ida")).toBe(true);
  });

  it("moves an upcoming visit with its accepted crew and pay snapshots, completed work to history, and keeps the rest for the Owner", () => {
    const visit = valuesOf("bookings")[0];
    expect(visit).toMatchObject({ date: "2026-12-10", time: "08:00", durationMinutes: "240", price: "262.04", service: "Deep Clean", line1: "110 Elm St" });
    const crew = visit.crew.split(";").map((c: string) => c.split("|"));
    expect(crew).toHaveLength(2);
    for (const c of crew) expect(c[1]).toBe("5240");
    expect(crew.every((c: string[]) => c[2] === "provisional")).toBe(true);
    expect(valuesOf("history")[0]).toMatchObject({ date: "2026-11-02", status: "completed", price: "202.78" });
    const byId = Object.fromEntries(adapted().records.filter((r) => r.table === "bookings").map((r) => [r.id, r.outcome]));
    expect(byId).toEqual({ b1: "staged", b2: "staged", b3: "archived", b4: "review", b5: "retained" });
    // An unanswered offer is not carried over, and no offer is sent.
    expect(adapted().records.find((r) => r.id === "a4")!.outcome).toBe("archived");
  });

  it("keeps every booking's accepted money as recorded, with provider references, and totals it by status", () => {
    const { finance } = adapted();
    const b1 = finance.visits.find((v) => v.ref.endsWith("/b1"))!;
    expect(b1).toMatchObject({ totalCents: 26204, depositCents: 13102, balanceCents: 13102, paymentStatus: "deposit_paid", stripe: { paymentIntent: "pi_TEST1", customer: "cus_TEST1" }, priceNotes: [] });
    expect(finance.visits.find((v) => v.ref.endsWith("/b3"))!.refundedCents).toBe(7639);
    const sum = finance.totals.reduce((n, t) => n + t.totalCents, 0);
    expect(sum).toBe(finance.visits.reduce((n, v) => n + (v.totalCents ?? 0), 0));
  });

  it("reads company settings: Central time, active ZIP codes only, Monday to Saturday 8 to 4, and a 40% share split by crew", () => {
    const { config } = adapted();
    expect(config.timezone).toBe("America/Chicago");
    expect(config.serviceAreas).toEqual(["77001", "77520"]);
    expect(config.hours.map((h) => h.weekday)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(config.hours[0]).toMatchObject({ startMinute: 480, endMinute: 960 });
    expect(config.pay.rule).toEqual({ shareBps: 4000, mode: "split_by_crew" });
    expect(config.promotions[0]).toMatchObject({ code: "NEW_CUSTOMER_50", words: "$50.00 off deep clean" });
  });

  it("counts outstanding links without copying them, and never stages a queued message", () => {
    const { links, records } = adapted();
    expect(links.find((l) => l.kind === "Customer manage-booking links")!.count).toBe(1);
    expect(links.find((l) => l.kind === "Cleaner offer and job links")!.count).toBe(1);
    expect(JSON.stringify(adapted().files)).not.toMatch(/token/i);
    expect(records.find((r) => r.table === "email_retry_queue")!.outcome).toBe("excluded");
    expect(CATALOG_BY_TABLE.get("email_retry_queue")!.disposition).toBe("excluded");
  });

  it("reads contact and time values carefully", () => {
    expect(realEmail("0f8fad5b-d9cb-469f-a165-70867728950e@bayareacleaningpros.com")).toBeNull();
    expect(realEmail("Real@Person.com")).toBe("real@person.com");
    expect(realPhone("0000000000")).toBeNull();
    expect(realPhone("+1 (281) 555-0101")).toBe("2815550101");
    expect(realPhone("555-0101")).toBeNull();
    expect(slotMinutes("2:00 PM - 4:00 PM")).toEqual({ start: 840, end: 960 });
    expect(slotMinutes("12:00 PM - 1:00 PM")).toEqual({ start: 720, end: 780 });
    expect(slotMinutes("TBD")).toBeNull();
  });
});
