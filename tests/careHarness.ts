/** Shared by the Client Care scenario tests: a company that can text, a client with a phone and consent, visits, plans and invoices. */
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { mockOutbox } from "../convex/lib/messaging/provider";
import { dispatchJob, HOUR } from "./harness";
import { flush } from "./dispatchHarness";
import { CUSTOMER_PHONE, DAY, retentionSetup } from "./retentionHarness";
import { homeSpec, publish } from "./salesHarness";

export { CUSTOMER_PHONE, DAY, HOUR };
/** Monday March 1, 2027 is NOW (6:00 AM in Chicago); visits are on Tuesdays and Wednesdays at 10:00 Chicago. */
export const TUESDAY_10 = Date.UTC(2027, 2, 2, 16, 0);
export const WEDNESDAY_10 = Date.UTC(2027, 2, 3, 16, 0);
export const WEEK = 7 * DAY;

let event = 0;

export async function careSetup() {
  const s = await retentionSetup();
  const { t, as, companyId } = s;
  // Cleaners work every weekday 8:00 to 17:00, so the team has capacity the reschedule options can come from.
  for (const cleanerId of Object.values(s.cleaners)) {
    await as.mutation(api.availability.setWeek, { companyId, cleanerId, windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 8 * 60, endMinute: 17 * 60 })) });
  }
  const db = <R>(work: Parameters<typeof t.run>[0]) => t.run(work) as Promise<R>;
  const helpers = {
    ...s,
    /** A text from a number to the company's number, as Telnyx's webhook delivers it. */
    text: async (body: string, from = CUSTOMER_PHONE, eventId?: string) => {
      event += 1;
      const result = await t.mutation(internal.inbound.telnyx, { eventId: eventId ?? `evt-care-${event}`, to: s.smsNumber, from, body, receivedAt: Date.now() });
      await flush(t);
      await flush(t);
      return result;
    },
    visit: async (startsAt: number, fields: { propertyId?: Id<"properties">; customerId?: Id<"customers">; accepted?: boolean } = {}) => {
      const jobId = await dispatchJob(as, companyId, { customerId: fields.customerId ?? s.place.customerId, propertyId: fields.propertyId ?? s.place.propertyId }, { startsAt, endsAt: startsAt + 2 * HOUR });
      if (fields.accepted) await t.run(async (ctx) => ctx.db.insert("assignments", { companyId, jobId, cleanerId: s.cleaners.Lena, status: "accepted", scope: "As booked", payCents: 8000, offeredAt: Date.now(), respondBy: startsAt - HOUR, respondedAt: Date.now() }));
      await flush(t);
      return jobId;
    },
    /** A running weekly plan with the visits named, written the way the plan engine writes them. */
    weeklyPlan: async (visits: number[]) => {
      const key = await publish(as, companyId, homeSpec());
      const planId = await t.run(async (ctx) => {
        const service = (await ctx.db.query("services").collect()).find((row) => row.companyId === companyId && row.key === key)!;
        return ctx.db.insert("servicePlans", { companyId, customerId: s.place.customerId, propertyId: s.place.propertyId, serviceId: service._id, kind: "recurring", state: "active", cadence: "every_7_days", startsOn: "2027-03-02", startTime: "10:00", durationMinutes: 120, arrivalWindowMinutes: 0, crewSize: 1, quoteInput: "{}", priceCents: 16000, firstVisit: null, scopeNote: "", preferredCleanerIds: [], skipped: [], revision: 1, createdBy: { kind: "system" }, createdAt: Date.now(), updatedAt: Date.now() });
      });
      const jobs: Id<"jobs">[] = [];
      for (const startsAt of visits) {
        const jobId = await dispatchJob(as, companyId, s.place, { startsAt, endsAt: startsAt + 2 * HOUR });
        await t.run(async (ctx) => ctx.db.patch(jobId, { planId, planDate: new Date(startsAt - 6 * HOUR).toISOString().slice(0, 10) }));
        jobs.push(jobId);
      }
      await flush(t);
      return { planId, jobs };
    },
    invoice: async (balanceCents: number, fields: { jobId?: Id<"jobs">; paidCents?: number; depositCents?: number } = {}) =>
      db<Id<"invoices">>(async (ctx) => {
        const paid = fields.paidCents ?? 0;
        return ctx.db.insert("invoices", { companyId, customerId: s.place.customerId, jobId: fields.jobId, number: "INV-1001", status: "open", lines: [], taxRateBps: 0, totals: { subtotalCents: balanceCents + paid, discountCents: 0, taxCents: 0, totalCents: balanceCents + paid, paidCents: paid, refundedCents: 0, creditedCents: 0, balanceCents, processingCents: 0 }, ...(fields.depositCents ? { depositCents: fields.depositCents } : {}), publicId: "inv-public-id-0123456789abcdef", revision: 0, issuedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() } as never);
      }),
    requests: () => db<Doc<"careRequests">[]>(async (ctx) => (await ctx.db.query("careRequests").collect()).filter((r) => r.companyId === companyId)),
    steps: () => db<Doc<"careSteps">[]>(async (ctx) => (await ctx.db.query("careSteps").collect()).filter((r) => r.companyId === companyId)),
    careMessages: () => db<Doc<"careMessages">[]>(async (ctx) => (await ctx.db.query("careMessages").collect()).filter((r) => r.companyId === companyId)),
    outbound: () => db<Doc<"messages">[]>(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.companyId === companyId && m.purpose === "client_care_reply")),
    job: (jobId: Id<"jobs">) => db<Doc<"jobs">>(async (ctx) => (await ctx.db.get(jobId))!),
    /** Texts accepted by the mock provider to the client, newest last. */
    replies: (phone = CUSTOMER_PHONE) => mockOutbox.filter((row) => row.to.endsWith(phone.replace(/\D/g, "")) && (row.result === "accepted" || row.result === "replayed")).map((row) => row.body),
    pending: async () => (await as.query(api.approvals.list, { companyId })).filter((row) => row.agent === "customer-care"),
    approveAll: async () => {
      const rows = (await as.query(api.approvals.list, { companyId })).filter((row) => row.agent === "customer-care");
      const out = [];
      for (const row of rows) out.push(await as.mutation(api.approvals.decide, { companyId, approvalId: row._id, decision: "approved" }));
      await flush(t);
      return out.map((r) => r.carriedOut);
    },
    allow: (action: string, level: "off" | "propose" | "execute_and_report" | "execute" = "execute") => as.mutation(api.permissions.set, { companyId, action, level }),
    /** The Owner sets the change notice in Care Setup. */
    policy: async (changeNoticeHours: number, lateChangeFeeCents?: number) => {
      const setup = await as.query(api.clientCare.setup, { companyId });
      await as.mutation(api.clientCare.saveSetup, { companyId, expectedRevision: setup.settings.revision, settings: { policy: { changeNoticeHours, lateChangeFeeCents, source: "Service terms" } } });
    },
    sweep: async () => {
      await t.mutation(internal.clientCareWork.sweep, {});
      await flush(t);
      await flush(t);
    },
    detail: (requestId: Id<"careRequests">) => as.query(api.clientCare.detail, { companyId, requestId }),
  };
  return helpers;
}
