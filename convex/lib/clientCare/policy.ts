/**
 * The change rules that apply to one client's visit, and where each came from: the client's own signed
 * agreement first, then Care Setup (the Owner's decision of November 25, 2026). With neither, nothing is
 * assumed: a change inside an unknown notice window is prepared for the Owner, and no fee is ever applied
 * or quoted by Care (care.apply_fee is a person's decision in every case).
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { governs } from "../agreements/agents";
import { localParts } from "../availability";
import { money } from "../dispatch/pay";
import { careSettings } from "./settings";

type Ctx = QueryCtx | MutationCtx;
const HOUR = 3_600_000;

export type ChangeRules = {
  noticeHours: number | null;
  feeCents: number | null;
  /** Where the rule came from, in words: "Your service agreement" or "Care Setup". Null: nothing says. */
  source: string | null;
  agreementId: Id<"agreements"> | null;
};

function numberTerm(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
}

export async function changeRules(ctx: Ctx, company: Doc<"companies">, customerId: Id<"customers">, propertyId: Id<"properties"> | null): Promise<ChangeRules> {
  const today = localParts(Date.now(), company.timezone).day;
  const links = [
    ...(await ctx.db.query("agreementLinks").withIndex("by_company_record", (q) => q.eq("companyId", company._id).eq("table", "customers").eq("recordId", customerId)).take(50)),
    ...(propertyId ? await ctx.db.query("agreementLinks").withIndex("by_company_record", (q) => q.eq("companyId", company._id).eq("table", "properties").eq("recordId", propertyId)).take(50) : []),
  ];
  for (const link of links) {
    const row = await ctx.db.get(link.agreementId);
    if (!row || row.companyId !== company._id || row.category !== "customer" || !governs(row, today)) continue;
    const notice = numberTerm(row.terms.rescheduleNoticeHours) ?? numberTerm(row.terms.bookingChangeNoticeHours);
    if (notice === null) continue;
    return { noticeHours: notice, feeCents: numberTerm(row.terms.lateCancelFeeCents), source: `${row.title} (signed agreement)`, agreementId: row._id };
  }
  const settings = careSettings(company);
  if (settings.policy.changeNoticeHours !== null) return { noticeHours: settings.policy.changeNoticeHours, feeCents: settings.policy.lateChangeFeeCents, source: settings.policy.source ? `Care Setup: ${settings.policy.source}` : "Care Setup", agreementId: null };
  return { noticeHours: null, feeCents: null, source: null, agreementId: null };
}

export type Timing = { ok: true; words: string } | { ok: false; late: boolean; words: string };

/** Whether a change to a visit starting at `startsAt` is inside the notice the rules give, asked now. */
export function timing(rules: ChangeRules, startsAt: number, now = Date.now()): Timing {
  if (rules.noticeHours === null) return { ok: false, late: false, words: "No change notice is set in the client's agreement or in Care Setup, so the Owner decides this change." };
  const hours = (startsAt - now) / HOUR;
  if (hours >= rules.noticeHours) return { ok: true, words: `More than ${rules.noticeHours} hours before the visit (${rules.source}).` };
  const fee = rules.feeCents ? ` ${rules.source} sets a late-change fee of ${money(rules.feeCents)}; only the Owner decides whether it applies.` : "";
  return { ok: false, late: true, words: `Less than ${rules.noticeHours} hours before the visit (${rules.source}).${fee}` };
}
