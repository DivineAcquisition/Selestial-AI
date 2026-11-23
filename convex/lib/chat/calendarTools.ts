/**
 * Company Chat's Calendar tools (docs/calendar/00-architecture.md, phase 5). They read: the schedule for
 * some days, from the same read as the Calendar page with the person's own role, and free times for named
 * people, from the same conflict rules as Calendar's events. They change nothing. A move or a booking is
 * made in Calendar, Dispatch or Recruiter, where the person sees what it does before it is saved.
 *
 * "Show tomorrow's uncovered jobs", "Explain the conflicts on Friday" and "Find interview availability
 * this week" are answered from these.
 */
import { readCalendar } from "../../calendar";
import type { Id } from "../../_generated/dataModel";
import type { MemberAccess } from "../builders";
import { checkEvent } from "../calendar/rules";
import { localParts } from "../availability";
import { localInstant, addDays } from "../sales/cadence";
import { businessSettingsOf } from "../settings/business";
import type { Field } from "./fields";
import type { ChatTool, Outcome, ToolCtx } from "./tools";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
const when = (at: number, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(at));
const refused = (why: string): Outcome => ({ status: "refused", why });

/** The chat's context, as the Calendar's own read expects it: this person, this company, their role. */
function asMember(ctx: ToolCtx) {
  return { ...ctx, companyId: ctx.company._id, identity: null as never, support: null } as unknown as Parameters<typeof readCalendar>[0] & MemberAccess;
}

function dayOf(input: unknown, timezone: string, fallbackDays: number): string | null {
  if (typeof input === "string" && DATE.test(input)) return input;
  if (input === undefined || input === null || input === "") return localParts(Date.now() + fallbackDays * DAY, timezone).day;
  return null;
}

const DATE_FIELD = (description: string): Field => ({ type: "string", description, optional: true, max: 10 });

export const CALENDAR_TOOLS: ChatTool[] = [
  {
    name: "calendar_schedule",
    label: "Reading the Calendar",
    description:
      "The company's schedule for up to 14 days from a date: visits with their crew and status, and, for Owners and Managers, interviews, walkthroughs, training, inspections, meetings and time away. Each item says what needs attention and why. Use `only` to keep just what needs attention, or just visits not fully staffed. The page the person is on may name the dates they are looking at.",
    kind: "read",
    minimumRole: "office",
    specialist: "dispatch",
    input: {
      type: "object",
      properties: {
        from: DATE_FIELD("First day, YYYY-MM-DD on the company's calendar. Defaults to today."),
        days: { type: "number", optional: true, description: "How many days, 1 to 14. Defaults to 1." },
        only: { type: "string", optional: true, description: "'attention' for items with problems, 'unstaffed' for visits not fully staffed." },
        deadlines: { type: "boolean", optional: true, description: "Include due tasks and renewals." },
      },
    },
    run: async (ctx, args) => {
      const timezone = ctx.company.timezone;
      const first = dayOf(args.from, timezone, 0);
      if (!first) return refused("Give the first day as YYYY-MM-DD.");
      const days = Math.min(14, Math.max(1, Math.round(Number(args.days ?? 1)) || 1));
      const from = localInstant(first, 0, timezone);
      const to = localInstant(addDays(first, days), 0, timezone);
      const member = asMember(ctx);
      const data = await readCalendar(member, { from, to, layers: ["jobs", "hiring", "sales", "quality", "availability", "business", ...(args.deadlines ? (["deadlines"] as const) : [])] });
      let items = data.items.filter((item) => item.status !== "cancelled");
      if (args.only === "attention") items = items.filter((item) => item.problems.length > 0);
      if (args.only === "unstaffed") items = items.filter((item) => ["booked", "offer_sent", "partly_staffed"].includes(item.status));
      const shown = items.slice(0, 80);
      return {
        status: "done",
        summary: `${items.length} on the Calendar from ${first}${days > 1 ? ` for ${days} days` : ""}${args.only ? ` (${args.only})` : ""}`,
        data: {
          timezone,
          items: shown.map((item) => ({
            what: item.kind.replace(/_/g, " "),
            title: item.title,
            detail: item.detail,
            when: item.allDay ? `${item.allDay}, all day` : item.timing === "due" ? `due ${when(item.startsAt, timezone)}` : `${when(item.startsAt, timezone)} to ${when(item.endsAt, timezone)}`,
            kindOfTime: item.timing,
            status: item.statusLabel,
            people: item.resources.map((row) => `${row.name}${row.state === "offered" ? " (offered, not accepted)" : ""}`),
            problems: item.problems,
            record: item.source.table === "jobs" ? { table: "jobs", id: item.source.id } : null,
          })),
          more: items.length > shown.length ? items.length - shown.length : 0,
          incomplete: data.limits.map((row) => row.source),
          waiting: { interviewsNeedingTime: data.waiting.interviews.length, correctionsToSchedule: data.waiting.corrections.length, changedInGoogle: data.waiting.googleChanges.length },
          note: "Travel time between properties is not looked up. A due date reserves no time. A projected visit is not booked.",
        },
        link: { href: `/app/calendar?view=${days === 1 ? "day" : "agenda"}&date=${first}`, label: "Open the Calendar" },
      };
    },
  },
  {
    name: "calendar_find_time",
    label: "Looking for a free time",
    description:
      "Free times when every named person can be booked, checked with Calendar's own rules: a cleaner's visits, offers, time off and other events, a member's time away, other events, interviews, walkthroughs, working hours and the connected calendar's busy times. Returns times with no hard conflict, fewest warnings first. Proposes only: it books nothing.",
    kind: "read",
    minimumRole: "manager",
    specialist: "dispatch",
    input: {
      type: "object",
      properties: {
        people: { type: "array", items: { type: "string", max: 80 }, description: "Names of the members and cleaners who must all be free.", maxItems: 8 },
        from: DATE_FIELD("First day to look, YYYY-MM-DD. Defaults to tomorrow."),
        days: { type: "number", optional: true, description: "How many days to look, 1 to 7. Defaults to 5." },
        minutes: { type: "number", optional: true, description: "How long, 15 to 480 minutes. Defaults to 60." },
      },
    },
    run: async (ctx, args) => {
      const timezone = ctx.company.timezone;
      const first = dayOf(args.from, timezone, 1);
      if (!first) return refused("Give the first day as YYYY-MM-DD.");
      const days = Math.min(7, Math.max(1, Math.round(Number(args.days ?? 5)) || 5));
      const minutes = Math.min(480, Math.max(15, Math.round(Number(args.minutes ?? 60)) || 60));
      const wanted = (Array.isArray(args.people) ? args.people : []).map((name) => String(name).trim().toLowerCase()).filter(Boolean);
      if (wanted.length === 0) return refused("Name the people who must be free.");
      const members = (await ctx.db.query("members").withIndex("by_company", (q) => q.eq("companyId", ctx.company._id)).take(200)).filter((row) => row.status === "active");
      const cleaners = await ctx.db.query("cleaners").withIndex("by_company_status", (q) => q.eq("companyId", ctx.company._id).eq("status", "ready")).take(400);
      const memberIds: Id<"members">[] = [];
      const cleanerIds: Id<"cleaners">[] = [];
      const unknown: string[] = [];
      for (const name of wanted) {
        const member = members.filter((row) => row.name.toLowerCase().includes(name));
        const cleaner = cleaners.filter((row) => row.name.toLowerCase().includes(name));
        // A name that could be several people is asked about, never guessed.
        if (member.length + cleaner.length > 1) return refused(`"${name}" could be ${[...member, ...cleaner].map((row) => row.name).join(", ")}. Say which.`);
        if (member[0]) memberIds.push(member[0]._id);
        else if (cleaner[0]) cleanerIds.push(cleaner[0]._id);
        else unknown.push(name);
      }
      if (unknown.length) return refused(`No active member or ready cleaner is called ${unknown.join(", ")}.`);
      // The company's own hours when it has set them; otherwise 8 AM to 6 PM.
      const hours = businessSettingsOf(ctx.company).hours;
      const member = asMember(ctx);
      const found: { startsAt: number; endsAt: number; warnings: string[] }[] = [];
      let checked = 0;
      for (let index = 0; index < days && checked < 160; index += 1) {
        const date = addDays(first, index);
        const weekday = localParts(localInstant(date, 12 * 60, timezone), timezone).weekday;
        const windows = hours.length ? hours.filter((row) => row.weekday === weekday) : [{ startMinute: 8 * 60, endMinute: 18 * 60 }];
        for (const window of windows) {
          for (let minute = window.startMinute; minute + minutes <= window.endMinute && checked < 160; minute += 30) {
            const startsAt = localInstant(date, minute, timezone);
            if (startsAt <= Date.now()) continue;
            checked += 1;
            const result = await checkEvent(member, { startsAt, endsAt: startsAt + minutes * 60_000 }, { memberIds, cleanerIds }, { kind: "meeting" });
            if (result.hard.length === 0) found.push({ startsAt, endsAt: startsAt + minutes * 60_000, warnings: result.warnings });
          }
        }
      }
      const best = found.sort((a, b) => a.warnings.length - b.warnings.length || a.startsAt - b.startsAt).slice(0, 6);
      return {
        status: "done",
        summary: best.length ? `${best.length} free time${best.length === 1 ? "" : "s"} found` : "No free time found in those days",
        data: {
          timezone,
          times: best.map((row) => ({ when: `${when(row.startsAt, timezone)} to ${when(row.endsAt, timezone)}`, warnings: row.warnings })),
          looked: `${days} day${days === 1 ? "" : "s"} from ${first}, ${minutes} minutes, every half hour within ${hours.length ? "the company's hours" : "8 AM to 6 PM"}${checked >= 160 ? " (stopped after 160 times; ask for fewer days to see the rest)" : ""}.`,
          note: "Nothing is booked or held. Travel time between properties is not looked up.",
        },
      };
    },
  },
];
