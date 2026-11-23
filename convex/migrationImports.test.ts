/**
 * @vitest-environment edge-runtime
 *
 * Importing appointments, recurring service and history: each row matched to one client or held back,
 * imported once however often a batch is sent, and nothing booked, started or billed because of it.
 */
import { describe, expect, it } from "vitest";

import { parseCsv } from "../src/lib/app/csv";
import { addMember, company, refusal, start } from "../tests/harness";
import { api } from "./_generated/api";
import { NOT_ALLOWED } from "./lib/errors";
import { guessRecordMapping, readCadence, readCents, readDay, readMinutes, readStart, readTime, recordKey, recordNotes, toRecordRow } from "./lib/migration/records";
import { streetStartsWith } from "./migrationImports";
import { dayOf } from "./lib/services/propertyPrices";

/** The columns Jobber's help center lists for its Visits report. */
const JOBBER_VISITS = `Job #,Date,Visit title,Client name,Client email,Client phone,Service street,Service city,Service state/province,Service ZIP/postal code,Visit completed,Assigned to,Scheduled duration
55,2099-03-04,Biweekly clean,Dana Whitfield,dana@example.com,512-555-0101,12 Elm St,Austin,TX,78701,No,Rosa,2.5
56,03/05/2099,Deep clean,Nobody Known,nobody@example.com,,1 Main St,Austin,TX,78701,No,,1
57,2001-01-02,Old visit,Dana Whitfield,dana@example.com,,12 Elm St,Austin,TX,78701,Yes,,1
58,not a date,Bad row,Dana Whitfield,,,,,,,,,`;

/** Jobber's Recurring jobs report columns. */
const JOBBER_RECURRING = `Job #,Job title,Client name,Client email,Visit frequency,Schedule start date,Schedule end date,Total ($)
70,Weekly home,Dana Whitfield,dana@example.com,Every 2 weeks,2099-01-06,,"$180.00"
71,Odd,Dana Whitfield,dana@example.com,Every 3rd Tuesday,2099-01-06,,`;

describe("Reading other systems' values", () => {
  it("reads dates, times, durations, money and frequencies as exports write them", () => {
    expect(readDay("2026-12-03")).toBe("2026-12-03");
    expect(readDay("12/03/2026")).toBe("2026-12-03");
    expect(readDay("Thu, Dec 3, 2026 9:00 AM")).toBe("2026-12-03");
    expect(readDay("2026-02-30")).toBeNull();
    expect(readDay("soon")).toBeNull();
    expect(readTime("2:05 pm")).toBe("14:05");
    expect(readTime("12:00 AM")).toBe("00:00");
    expect(readTime("2026-12-03 09:30")).toBe("09:30");
    expect(readMinutes("2.5")).toBe(150);
    expect(readMinutes("90")).toBe(90);
    expect(readMinutes("1:30")).toBe(90);
    expect(readMinutes("45 min")).toBe(45);
    expect(readCents("$1,234.50")).toBe(123450);
    expect(readCents("(45.00)")).toBe(-4500);
    expect(readCents("abc")).toBeNull();
    expect(readCadence("Weekly")).toBe("every_7_days");
    expect(readCadence("Every 2 weeks")).toBe("every_14_days");
    expect(readCadence("Every 4 weeks")).toBe("every_28_days");
    expect(readCadence("Monthly")).toBe("once_per_month");
    expect(readCadence("Twice a month")).toBe("twice_per_month");
    // Not said plainly: kept as written, never guessed.
    expect(readCadence("Every 3rd Tuesday")).toBeNull();
  });

  it("reads the start from the date column, on the company's clock, on both sides of a daylight-saving change", () => {
    // No Start time column: the time written with the date is the start.
    expect(readStart({ date: "2099-03-04 9:30 AM" }, "America/Chicago")).toEqual({ day: "2099-03-04", time: "09:30" });
    expect(readStart({ date: "03/04/2099 14:00" }, "America/Chicago")).toEqual({ day: "2099-03-04", time: "14:00" });
    expect(readStart({ date: "2099-03-04" }, "America/Chicago")).toEqual({ day: "2099-03-04", time: null });
    // A Start time column wins over the time in the date column.
    expect(readStart({ date: "2099-03-04 09:30", time: "1:15 PM" }, "America/Chicago")).toEqual({ day: "2099-03-04", time: "13:15" });
    // A timestamp with a zone is an instant: 02:00 UTC on the 3rd is the evening of the 2nd in Chicago.
    expect(readStart({ date: "2026-12-03T02:00Z" }, "America/Chicago")).toEqual({ day: "2026-12-02", time: "20:00" });
    expect(readStart({ date: "2026-12-03T23:30:00-08:00" }, "America/New_York")).toEqual({ day: "2026-12-04", time: "02:30" });
    expect(readStart({ date: "2026-12-03 18:00:00+0530" }, "America/Chicago")).toEqual({ day: "2026-12-03", time: "06:30" });
    // Spring forward in New York, 2026-03-08: 01:30 EST, then 03:30 EDT an hour later.
    expect(readStart({ date: "2026-03-08T06:30:00Z" }, "America/New_York")).toEqual({ day: "2026-03-08", time: "01:30" });
    expect(readStart({ date: "2026-03-08T07:30:00Z" }, "America/New_York")).toEqual({ day: "2026-03-08", time: "03:30" });
    // Fall back, 2026-11-01: 01:30 happens twice; the day before is still on daylight time.
    expect(readStart({ date: "2026-11-01T05:30:00.000Z" }, "America/New_York")).toEqual({ day: "2026-11-01", time: "01:30" });
    expect(readStart({ date: "2026-11-01T06:30:00Z" }, "America/New_York")).toEqual({ day: "2026-11-01", time: "01:30" });
    expect(readStart({ date: "2026-11-01T03:59:00Z" }, "America/New_York")).toEqual({ day: "2026-10-31", time: "23:59" });
    expect(readStart({ date: "2026-11-02T04:59:00Z" }, "America/New_York")).toEqual({ day: "2026-11-01", time: "23:59" });
    // A wall-clock time with no zone is never shifted.
    expect(readStart({ date: "2026-03-08T02:30:00" }, "America/New_York")).toEqual({ day: "2026-03-08", time: "02:30" });
  });

  it("keeps two visits on one day apart by time and street, and never guesses what bi-monthly means", () => {
    const base = { clientName: "Dana Whitfield", clientEmail: "dana@example.com" };
    const keys = [
      recordKey("appointment", { ...base, date: "2099-03-04 09:00", street: "12 Elm St" }, "America/Chicago"),
      recordKey("appointment", { ...base, date: "2099-03-04 13:00", street: "12 Elm St" }, "America/Chicago"),
      recordKey("appointment", { ...base, date: "2099-03-04 09:00", street: "40 Lake Rd" }, "America/Chicago"),
    ];
    expect(new Set(keys).size).toBe(3);
    expect(recordKey("appointment", { ...base, date: "2099-03-04 09:00", street: " 12  elm st. " }, "America/Chicago")).toBe(keys[0]);
    for (const words of ["Bi-monthly", "bimonthly", "Bi Monthly"]) expect(readCadence(words)).toBeNull();
    expect(readCadence("Semi-monthly")).toBe("twice_per_month");
    expect(recordNotes("recurring", { ...base, frequency: "Bi-monthly" }, "2026-01-01")[0]).toMatch(/twice a month or every two months/);
    // "12 Oakland Ave" is not at "12 Oak"; "12 Oak, Apt 4" is.
    expect(streetStartsWith("12 oakland ave", "12 oak")).toBe(false);
    expect(streetStartsWith("12 oak, apt 4", "12 oak")).toBe(true);
    expect(streetStartsWith("12 oak", "12 oak")).toBe(true);
  });

  it("maps Jobber's report columns as suggestions", () => {
    const csv = parseCsv(JOBBER_VISITS);
    const mapping = guessRecordMapping("appointment", csv[0]);
    expect(toRecordRow(csv[1], mapping)).toMatchObject({ clientName: "Dana Whitfield", clientEmail: "dana@example.com", street: "12 Elm St", date: "2099-03-04", duration: "2.5", description: "Biweekly clean", assignedTo: "Rosa", reference: "55" });
    const recurring = parseCsv(JOBBER_RECURRING);
    expect(toRecordRow(recurring[1], guessRecordMapping("recurring", recurring[0]))).toMatchObject({ frequency: "Every 2 weeks", date: "2099-01-06", amount: "$180.00" });
  });
});

describe("Records import", () => {
  async function seeded() {
    const t = start();
    const owner = await company(t, "owner-a", "Alpha Cleaning");
    await owner.as.mutation(api.clientImports.commit, {
      companyId: owner.companyId,
      importKey: "clients:0",
      source: "jobber",
      label: "Jobber clients",
      rows: [{ index: 0, row: { name: "Dana Whitfield", email: "dana@example.com", phone: "512-555-0101", line1: "12 Elm St", city: "Austin", region: "TX", postalCode: "78701" } }],
      addAnyway: [],
      skip: [],
    });
    return { t, ...owner };
  }

  it("matches each row to one client, keeps past visits as history, and imports once", async () => {
    const { t, as, companyId } = await seeded();
    const csv = parseCsv(JOBBER_VISITS);
    const mapping = guessRecordMapping("appointment", csv[0]);
    const rows = csv.slice(1).map((cells) => toRecordRow(cells, mapping));

    const check = await as.query(api.migrationImports.check, { companyId, kind: "appointment", rows });
    expect(check.rows[0]).toMatchObject({ client: { name: "Dana Whitfield", by: "email" }, problems: [] });
    expect(check.rows[1].problems[0]).toMatch(/No client in Selestial matches/);
    expect(check.rows[2].notes[0]).toMatch(/has passed/);
    expect(check.rows[3].problems[0]).toMatch(/isn't a date/);
    expect(check.willCreate).toBe(2);

    const batch = rows.map((row, index) => ({ index, row }));
    const first = await as.mutation(api.migrationImports.commit, { companyId, importKey: "visits:0", kind: "appointment", source: "jobber", label: "Visits", rows: batch });
    expect(first).toMatchObject({ repeated: false, created: 2, failed: 2 });
    const again = await as.mutation(api.migrationImports.commit, { companyId, importKey: "visits:0", kind: "appointment", source: "jobber", label: "Visits", rows: batch });
    expect(again).toMatchObject({ repeated: true, created: 2 });
    // The same file under a new key adds nothing new.
    const other = await as.mutation(api.migrationImports.commit, { companyId, importKey: "visits-again:0", kind: "appointment", source: "jobber", label: "Visits", rows: batch });
    expect(other).toMatchObject({ created: 0, skipped: 2 });

    const summary = await as.query(api.migrationImports.summary, { companyId });
    expect(summary).toMatchObject({ clients: 1, appointments: { waiting: 1 }, history: 1 });
    // Nothing was booked: importing an appointment is not a visit.
    const jobs = await t.run(async (ctx) => ctx.db.query("jobs").collect());
    expect(jobs).toEqual([]);
    const records = await t.run(async (ctx) => ctx.db.query("migrationRecords").collect());
    expect(records.find((row) => row.kind === "appointment")).toMatchObject({ day: "2099-03-04", durationMinutes: 150, review: "review" });
    expect(records.find((row) => row.kind === "appointment")?.propertyId).toBeDefined();
  });

  it("keeps a recurring schedule for review with its cadence, and starts no plan", async () => {
    const { t, as, companyId } = await seeded();
    const csv = parseCsv(JOBBER_RECURRING);
    const mapping = guessRecordMapping("recurring", csv[0]);
    const rows = csv.slice(1).map((cells) => toRecordRow(cells, mapping));
    const check = await as.query(api.migrationImports.check, { companyId, kind: "recurring", rows });
    expect(check.rows[1].notes[0]).toMatch(/kept as written/);
    await as.mutation(api.migrationImports.commit, { companyId, importKey: "recurring:0", kind: "recurring", source: "jobber", label: "Recurring", rows: rows.map((row, index) => ({ index, row })) });
    const waiting = await as.query(api.migrationImports.waiting, { companyId, kind: "recurring" });
    expect(waiting.map((row) => row.cadence)).toEqual(["every_14_days", null]);
    expect(waiting[0].amountCents).toBe(18000);
    expect(await t.run(async (ctx) => ctx.db.query("servicePlans").collect())).toEqual([]);
  });

  it("imports two visits for one client on one day, with the times from the date column", async () => {
    const { t, as, companyId } = await seeded();
    const customer = (await t.run(async (ctx) => ctx.db.query("customers").first()))!;
    await as.mutation(api.properties.create, { companyId, customerId: customer._id, kind: "home", address: { line1: "12 Elm", city: "Austin", region: "TX", postalCode: "78701" } });
    const csv = parseCsv(`Client name,Client email,Service street,Scheduled start
Dana Whitfield,dana@example.com,12 Elm St,2099-03-04 09:00
Dana Whitfield,dana@example.com,12 Elm St,2099-03-04 13:30
Dana Whitfield,dana@example.com,12 Elmwood Ct,2099-03-04 09:00
Dana Whitfield,dana@example.com,12 Elm St,2099-03-05T02:00:00Z
Dana Whitfield,dana@example.com,12 Elm St,2099-03-04 09:00`);
    const mapping = guessRecordMapping("appointment", csv[0]);
    expect(mapping.time).toBeUndefined();
    const rows = csv.slice(1).map((cells) => toRecordRow(cells, mapping));
    const check = await as.query(api.migrationImports.check, { companyId, kind: "appointment", rows });
    expect(check.willCreate).toBe(4);
    expect(check.rows[4].sameAsRow).toBe(0);
    const done = await as.mutation(api.migrationImports.commit, { companyId, importKey: "same-day:0", kind: "appointment", source: "jobber", label: "Visits", rows: rows.map((row, index) => ({ index, row })) });
    expect(done).toMatchObject({ created: 4, skipped: 1, failed: 0 });
    const records = (await t.run(async (ctx) => ctx.db.query("migrationRecords").collect())).sort((a, b) => a._creationTime - b._creationTime);
    // 02:00 UTC on the 5th is 8 pm on the 4th in Chicago.
    expect(records.map((row) => [row.day, row.time])).toEqual([["2099-03-04", "09:00"], ["2099-03-04", "13:30"], ["2099-03-04", "09:00"], ["2099-03-04", "20:00"]]);
    // "12 Elm St" is the client's own address, never the shorter "12 Elm"; "12 Elmwood Ct" is neither.
    const elmSt = (await t.run(async (ctx) => ctx.db.query("properties").collect())).find((p) => p.address.line1 === "12 Elm St")!;
    expect(records.map((row) => row.propertyId)).toEqual([elmSt._id, elmSt._id, undefined, elmSt._id]);
    expect((await as.mutation(api.migrationImports.commit, { companyId, importKey: "same-day-again:0", kind: "appointment", source: "jobber", label: "Visits", rows: rows.map((row, index) => ({ index, row })) })).created).toBe(0);
  });

  it("recognizes a record kept under the old key once, so the visit it used to hide is imported", async () => {
    const { t, as, companyId } = await seeded();
    const rows = [
      { clientName: "Dana Whitfield", clientEmail: "dana@example.com", date: "2099-03-04 09:00" },
      { clientName: "Dana Whitfield", clientEmail: "dana@example.com", date: "2099-03-04 13:30" },
    ];
    const first = await as.mutation(api.migrationImports.commit, { companyId, importKey: "old:0", kind: "appointment", source: "csv", label: "Visits", rows: [{ index: 0, row: rows[0] }] });
    expect(first.created).toBe(1);
    // As it was stored before: no time, and a key without the street or the date column's time.
    const stored = (await t.run(async (ctx) => ctx.db.query("migrationRecords").first()))!;
    await t.run(async (ctx) => ctx.db.patch(stored._id, { key: "appointment||2099-03-04||dana@example.com|", time: undefined }));
    const again = await as.mutation(api.migrationImports.commit, { companyId, importKey: "old:1", kind: "appointment", source: "csv", label: "Visits", rows: rows.map((row, index) => ({ index, row })) });
    expect(again).toMatchObject({ created: 1, skipped: 1 });
    const records = await t.run(async (ctx) => ctx.db.query("migrationRecords").collect());
    expect(records.map((row) => row.time).sort()).toEqual(["09:00", "13:30"]);
  });

  it("holds back a row whose email and phone belong to different clients", async () => {
    const { as, companyId } = await seeded();
    await as.mutation(api.clients.create, { companyId, type: "person", name: "Sam Ortiz", kind: "home", contact: { name: "Sam Ortiz", phone: "512-555-0199" }, addAnyway: true });
    const check = await as.query(api.migrationImports.check, { companyId, kind: "appointment", rows: [{ clientName: "Dana Whitfield", clientEmail: "dana@example.com", clientPhone: "(512) 555-0199", date: "2099-03-04" }] });
    expect(check.rows[0].client).toBeNull();
    expect(check.rows[0].problems[0]).toMatch(/email belongs to Dana Whitfield and the phone to Sam Ortiz/);
    expect(check.willCreate).toBe(0);
  });

  it("reconciles upcoming imported visits against the calendar, and ties 'set up' to a real visit or the owner's word", async () => {
    const { t, as, companyId } = await seeded();
    const tz = "America/Chicago";
    const at = (days: number) => Math.floor((Date.now() + days * 86_400_000) / 3_600_000) * 3_600_000;
    const [day1, day2] = [dayOf(at(3), tz), dayOf(at(5), tz)];
    await as.mutation(api.migrationImports.commit, {
      companyId,
      importKey: "upcoming:0",
      kind: "appointment",
      source: "jobber",
      label: "Visits",
      rows: [
        { index: 0, row: { clientName: "Dana Whitfield", clientEmail: "dana@example.com", date: `${day1} 09:00`, amount: "$150.00" } },
        { index: 1, row: { clientName: "Dana Whitfield", clientEmail: "dana@example.com", date: `${day2} 09:00`, amount: "$150.00" } },
        { index: 2, row: { clientName: "Dana Whitfield", clientEmail: "dana@example.com", date: "2099-03-04 09:00", amount: "$150.00" } },
      ],
    });
    await as.mutation(api.migrationImports.commit, { companyId, importKey: "upcoming-recurring:0", kind: "recurring", source: "jobber", label: "Recurring", rows: [{ index: 0, row: { clientName: "Dana Whitfield", clientEmail: "dana@example.com", frequency: "Every 2 weeks", amount: "$180.00" } }] });
    let summary = await as.query(api.migrationImports.summary, { companyId });
    expect(summary.reconciliation).toMatchObject({ from: "Jobber", settled: false, missingCount: 2, visits: { total: 2, scheduled: 0, waiting: 2, importedCents: 30000, scheduledCents: 0 }, schedules: { total: 1, withPlan: 0, waiting: 1, importedCents: 18000 } });
    expect(summary.appointments.upcoming.waiting).toEqual({ count: 3, amountCents: 45000, unpriced: 0 });
    expect(summary.recurring.totals.waiting).toEqual({ count: 1, amountCents: 18000, unpriced: 0 });

    // No visit that day in Selestial: "Mark done" marks nothing until the owner says they set it up themselves.
    const records = (await t.run(async (ctx) => ctx.db.query("migrationRecords").collect())).filter((row) => row.kind === "appointment").sort((a, b) => (a.day ?? "").localeCompare(b.day ?? ""));
    const asked = await as.mutation(api.migrationImports.decide, { companyId, recordId: records[0]._id, review: "set_up" });
    expect(asked).toMatchObject({ outcome: "confirm_needed" });
    expect((await t.run(async (ctx) => ctx.db.get(records[0]._id)))?.review).toBe("review");

    // The owner books the visit through the normal screens; the import never did.
    expect(await t.run(async (ctx) => ctx.db.query("jobs").collect())).toEqual([]);
    const customer = (await t.run(async (ctx) => ctx.db.query("customers").first()))!;
    const property = (await t.run(async (ctx) => ctx.db.query("properties").first()))!;
    const jobId = await as.mutation(api.jobs.create, { companyId, customerId: customer._id, propertyId: property._id, serviceType: "standard", scope: "Standard clean", startsAt: Date.parse(`${day1}T15:00:00Z`), endsAt: Date.parse(`${day1}T17:00:00Z`), priceCents: 16000 });
    summary = await as.query(api.migrationImports.summary, { companyId });
    expect(summary.reconciliation.visits).toMatchObject({ total: 2, scheduled: 1, waiting: 1, importedCents: 30000, scheduledCents: 16000 });
    expect(summary.reconciliation.missing.map((row) => [row.day, row.state])).toEqual([[day2, "waiting"]]);
    expect(await as.mutation(api.migrationImports.decide, { companyId, recordId: records[0]._id, review: "set_up" })).toEqual({ outcome: "linked", to: "visit" });
    expect((await t.run(async (ctx) => ctx.db.get(records[0]._id)))).toMatchObject({ review: "set_up", jobId });

    expect(await as.mutation(api.migrationImports.decide, { companyId, recordId: records[1]._id, review: "set_up", confirmSelf: true })).toEqual({ outcome: "confirmed_by_you" });
    expect((await t.run(async (ctx) => ctx.db.get(records[1]._id)))).toMatchObject({ review: "set_up", selfConfirmed: true });
    summary = await as.query(api.migrationImports.summary, { companyId });
    expect(summary.reconciliation.visits).toMatchObject({ scheduled: 1, waiting: 0, confirmedByYou: 1 });
    expect(summary.reconciliation.settled).toBe(false);

    // The schedule is deliberately skipped: nothing upcoming is left waiting.
    const schedule = (await t.run(async (ctx) => ctx.db.query("migrationRecords").collect())).find((row) => row.kind === "recurring")!;
    expect(await as.mutation(api.migrationImports.decide, { companyId, recordId: schedule._id, review: "dismissed" })).toEqual({ outcome: "skipped" });
    summary = await as.query(api.migrationImports.summary, { companyId });
    expect(summary.reconciliation).toMatchObject({ settled: true, schedules: { total: 0, skipped: 1 } });
    expect(summary.recurring.totals.skipped).toEqual({ count: 1, amountCents: 18000, unpriced: 0 });
    // Reviewing made no visit and no plan.
    expect(await t.run(async (ctx) => ctx.db.query("jobs").collect())).toHaveLength(1);
    expect(await t.run(async (ctx) => ctx.db.query("servicePlans").collect())).toEqual([]);
  });

  it("refuses an Office member, and a row that matches two clients", async () => {
    const { t, as, companyId } = await seeded();
    const office = await addMember(t, as, companyId, "office-a", "office");
    expect(await refusal(office.query(api.migrationImports.check, { companyId, kind: "history", rows: [] }))).toBe(NOT_ALLOWED);
    await as.mutation(api.clients.create, { companyId, type: "person", name: "Dana Whitfield", kind: "home", contact: { name: "Dana Whitfield" }, addAnyway: true });
    const check = await as.query(api.migrationImports.check, { companyId, kind: "history", rows: [{ clientName: "Dana Whitfield", date: "2025-01-02", amount: "120" }] });
    expect(check.rows[0].problems[0]).toMatch(/More than one client/);
  });
});

describe("Selestial's templates", () => {
  it("map every column without the owner choosing any", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (name: string) => parseCsv(readFileSync(new URL(`../public/templates/${name}`, import.meta.url), "utf8"));
    for (const [kind, name] of [["appointment", "selestial-appointments.csv"], ["recurring", "selestial-recurring.csv"], ["history", "selestial-history.csv"]] as const) {
      const [header] = read(name);
      expect(Object.keys(guessRecordMapping(kind, header)).length, name).toBe(header.length);
    }
    const { guessMapping } = await import("./lib/clients/importing");
    const [clients] = read("selestial-clients.csv");
    expect(Object.keys(guessMapping(clients)).length).toBe(clients.length);
  });
});
