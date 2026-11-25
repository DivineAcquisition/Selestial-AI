/**
 * @vitest-environment edge-runtime
 *
 * A sample company for Care's screens, built through the real backend (convex-test) with the mock text
 * provider: a question answered from the visit, a reschedule waiting for approval, a complaint with the team, a
 * change made whose message didn't go, a question waiting on the client, and an urgent concern. The test checks
 * what the screens' queries return; with CARE_SCREENS_OUT set it also writes those answers to that file, which
 * the screen tests (src/components/app/screens/care/care.test.tsx) render.
 */
import { writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { careSetup, TUESDAY_10, WEDNESDAY_10, WEEK } from "../tests/careHarness";
import { dispatchTestEnv, flush } from "../tests/dispatchHarness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

let undo: () => void;
beforeEach(() => {
  undo = dispatchTestEnv();
});
afterEach(() => undo());

describe("Care's screens", () => {
  it("say what is true on the record, and claim nothing else", async () => {
    const s = await careSetup();
    const { as, companyId, t } = s;
    await s.policy(24);
    const client = async (name: string, phone: string) => {
      const customerId = await as.mutation(api.customers.create, { companyId, name, kind: "home", phone });
      const propertyId = await as.mutation(api.properties.create, { companyId, customerId, kind: "home", address: { line1: `${name.split(" ")[1]} House, 4 Oak Ave`, city: "Austin", region: "TX", postalCode: "78701" } });
      await as.mutation(api.consent.record, { companyId, recipient: { kind: "customer", id: customerId }, channel: "sms", category: "operational", status: "granted", source: "web_form", evidence: "Booking form." });
      return { customerId, propertyId };
    };
    // Dana: a question answered from her accepted visit.
    await s.visit(TUESDAY_10, { accepted: true });
    await s.text("Who is coming on Tuesday?");
    // Marcus: a reschedule waiting for the Owner's approval.
    const marcus = await client("Marcus Reed", "+15550108811");
    await s.visit(WEDNESDAY_10, marcus);
    await s.text("Please reschedule Wednesday's cleaning to Thursday at 11am", "+15550108811");
    // Priya: a complaint with Quality and Retention.
    const priya = await client("Priya Nair", "+15550108822");
    await s.completed({ customerId: priya.customerId, propertyId: priya.propertyId, scope: "A full clean." });
    await s.text("The kitchen counters weren't wiped", "+15550108822");
    // Jo: a preference recorded on the visit, and the message telling her didn't go (a number that never delivers).
    const jo = await client("Jo Alvarez", "+15550100001");
    await s.visit(TUESDAY_10 + WEEK, jo);
    await s.allow("care.update_preferences", "execute");
    await s.text("Please don't clean the guest bedroom next Tuesday only", "+15550100001");
    // Sam: asked to cancel, and Care asked what that means.
    const sam = await client("Sam Okafor", "+15550108833");
    await s.weeklyPlan([TUESDAY_10, TUESDAY_10 + WEEK]).catch(() => null);
    await t.run(async (ctx) => {
      for (const job of await ctx.db.query("jobs").collect()) if (job.planId && job.customerId === s.place.customerId && job.startsAt > TUESDAY_10) await ctx.db.patch(job._id, { customerId: sam.customerId, propertyId: sam.propertyId });
      for (const plan of await ctx.db.query("servicePlans").collect()) await ctx.db.patch(plan._id, { customerId: sam.customerId, propertyId: sam.propertyId });
    });
    await s.text("I need to cancel", "+15550108833");
    // Lee: an urgent concern.
    const lee = await client("Lee Chen", "+15550108844");
    await s.completed({ customerId: lee.customerId, propertyId: lee.propertyId, scope: "A full clean." });
    await s.text("Your cleaner broke a lamp in the hallway", "+15550108844");
    await flush(t);

    const now = Date.now();
    const overview = await as.query(api.clientCare.overview, { companyId, asOf: now });
    const list = await as.query(api.clientCare.list, { companyId });
    const followUps = await as.query(api.clientCare.followUps, { companyId, asOf: now });
    const setup = await as.query(api.clientCare.setup, { companyId });
    const requests = await s.requests();
    const byName = async (name: string) => {
      const customer = await t.run(async (ctx) => (await ctx.db.query("customers").collect()).find((c) => c.name === name)!);
      return requests.find((r) => r.customerId === customer._id)!._id as Id<"careRequests">;
    };
    const details = {
      reschedule: await as.query(api.clientCare.detail, { companyId, requestId: await byName("Marcus Reed") }),
      complaint: await as.query(api.clientCare.detail, { companyId, requestId: await byName("Priya Nair") }),
      partial: await as.query(api.clientCare.detail, { companyId, requestId: await byName("Jo Alvarez") }),
      answered: await as.query(api.clientCare.detail, { companyId, requestId: await byName("Dana Whitfield") }),
    };

    expect(list.rows.length).toBeGreaterThanOrEqual(5);
    expect(overview.counts.decisions).toBeGreaterThanOrEqual(2);
    expect(overview.urgent.map((c) => c.customer.name)).toEqual(["Lee Chen"]);
    expect(details.reschedule.steps.map((st) => st.statusWords)).toContain("Waiting for approval");
    expect(details.partial.steps.find((st) => st.retry)).toBeTruthy();
    expect(details.answered.request.status).toBe("resolved");
    expect(followUps.some((row) => row.mode === "approval")).toBe(true);
    expect(setup.permissions.find((p) => p.key === "care.answer_question")?.level).toBe("execute");
    expect(setup.permissions.find((p) => p.key === "care.reschedule_visit")?.level).toBe("propose");
    // No productivity, savings or certainty is ever claimed, and no access code is shown.
    const everything = JSON.stringify({ overview, list, followUps, setup, details });
    expect(everything).not.toMatch(/hours? saved|time saved|saved you|confidence|"score"|percent/i);

    const out = process.env.CARE_SCREENS_OUT;
    if (out) writeFileSync(out, JSON.stringify({ now, overview, list, followUps, setup, details }, null, 1));
  });
});
