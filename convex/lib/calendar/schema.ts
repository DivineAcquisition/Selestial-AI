/**
 * Calendar's own records (docs/calendar/00-architecture.md, phase 3). Only what no other workflow holds:
 * meetings and manual appointments, a member's unavailable time, training sessions and inspections, and
 * members' weekly working hours. A visit is still a job, an interview an interview, a walkthrough an
 * assessment: nothing here stands in for them.
 *
 * Nothing is deleted. Cancelling keeps the record, who cancelled it and why.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

import { actorValidator } from "../events";
import { literals } from "../statuses";

/**
 * meeting: an internal meeting. appointment: a manual appointment with someone outside the company.
 * unavailable: a member's time away (it blocks only the members named). training: an onboarding or
 * training session led by a member or trainer, attended by new hires. inspection: a scheduled quality
 * inspection at a property, by a member or a lead cleaner.
 */
export const EVENT_KINDS = ["meeting", "appointment", "unavailable", "training", "inspection"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_STATUSES = ["scheduled", "completed", "cancelled"] as const;

export const attendanceValidator = v.object({
  cleanerId: v.id("cleaners"),
  attended: v.boolean(),
  by: v.id("members"),
  at: v.number(),
  /** The onboarding requirement a person recorded as done because of this session, if any. */
  requirementKey: v.optional(v.string()),
});

export const calendarTables = {
  calendarEvents: defineTable({
    companyId: v.id("companies"),
    kind: literals(EVENT_KINDS),
    title: v.string(),
    /** Shown to whoever may see the event. Never access instructions, which stay on the property. */
    notes: v.optional(v.string()),
    /** Where: a room, an address, a call link. */
    location: v.optional(v.string()),
    startsAt: v.number(),
    endsAt: v.number(),
    /** A whole-day event: the first and last company-calendar date it covers (YYYY-MM-DD). */
    allDay: v.optional(v.object({ from: v.string(), through: v.string() })),
    /** The zone the event was scheduled in. */
    timezone: v.string(),
    status: literals(EVENT_STATUSES),
    /**
     * A private event shows as "Busy" to everyone except the person who made it and the members on it.
     * Its title, notes and place are never returned to anyone else.
     */
    private: v.boolean(),
    /** Members whose time it takes: attendees, the person away, the trainer, the inspector. */
    memberIds: v.array(v.id("members")),
    /** Cleaners whose time it takes: training attendees, or a lead cleaner inspecting. */
    cleanerIds: v.array(v.id("cleaners")),
    /** Training: who leads it. A member, or a cleaner acting as trainer. */
    leadMemberId: v.optional(v.id("members")),
    leadCleanerId: v.optional(v.id("cleaners")),
    /** Links to the records it is about. Each was checked to belong to the company when set. */
    customerId: v.optional(v.id("customers")),
    propertyId: v.optional(v.id("properties")),
    jobId: v.optional(v.id("jobs")),
    qualityCaseId: v.optional(v.id("qualityCases")),
    handoffIds: v.optional(v.array(v.id("onboardingHandoffs"))),
    /** Training: what a person recorded about each attendee. Recorded, never assumed. */
    attendance: v.optional(v.array(attendanceValidator)),
    /** Inspection: what the inspector found, in their words. It is not a quality review or a verdict on anyone. */
    inspection: v.optional(v.object({ result: v.union(v.literal("no_issues"), v.literal("issues_found"), v.literal("not_done")), note: v.string(), by: v.id("members"), at: v.number() })),
    /** A hard conflict a person chose to override, with who and why. */
    override: v.optional(v.object({ conflicts: v.array(v.string()), reason: v.string(), by: v.id("members"), at: v.number() })),
    cancelled: v.optional(v.object({ reason: v.string(), by: actorValidator, at: v.number() })),
    /** Counts changes, so a change prepared against an older version is refused as stale. */
    revision: v.number(),
    createdBy: actorValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_company_start", ["companyId", "startsAt"])
    .index("by_company_kind_start", ["companyId", "kind", "startsAt"])
    .index("by_company_case", ["companyId", "qualityCaseId"]),

  /** A member's weekly working hours, on the company's clock. None on record means none set, not "never works". */
  memberHours: defineTable({
    companyId: v.id("companies"),
    memberId: v.id("members"),
    weekday: v.number(),
    startMinute: v.number(),
    endMinute: v.number(),
  }).index("by_company_member", ["companyId", "memberId"]),
};
