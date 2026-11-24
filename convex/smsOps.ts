/**
 * Staff › Texting operations (docs/sms/00-architecture.md §7, phase 6): one place to see whether texting is
 * healthy across Selestial. Staff only; read only; counts and states, never a message's words, a code or a
 * full phone number.
 *
 *   overview  the Telnyx account (last read-only check, balance), the send queue (what's waiting and for how
 *             long), the last 24 hours of company texts, Selestial's own texts (codes sent and refused, by
 *             reason; notices; what Telnyx charged Selestial), and the open texting incidents
 */
import { staffQuery } from "./lib/builders";
import type { Check } from "./lib/operations/catalog";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const TEXTING_CHECKS: readonly Check[] = ["provider_health", "platform_sms", "uncertain_messages", "stuck_sends", "inbound_processing", "texting", "messaging_billing", "messaging_attention"];

export const overview = staffQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const probe = await ctx.db
      .query("opsSignals")
      .withIndex("by_kind_at", (q) => q.eq("kind", "provider_probe"))
      .order("desc")
      .first();

    // The send queue: what is waiting, and the oldest of each.
    const queue: Record<"queued" | "held" | "sending" | "unconfirmed", { count: number; oldest: number | null }> = { queued: { count: 0, oldest: null }, held: { count: 0, oldest: null }, sending: { count: 0, oldest: null }, unconfirmed: { count: 0, oldest: null } };
    for (const status of ["queued", "held", "sending", "unconfirmed"] as const) {
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_status_attempted", (q) => q.eq("status", status))
        .take(1000);
      const sms = rows.filter((row) => (row.channel ?? "sms") === "sms");
      queue[status] = { count: sms.length, oldest: sms.length ? Math.min(...sms.map((row) => row.queuedAt)) : null };
    }

    // The last day of company texts that were attempted, by what became of them.
    const day = { delivered: 0, accepted: 0, notConfirmed: 0, failed: 0 };
    for (const status of ["delivered", "sent", "failed"] as const) {
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_status_attempted", (q) => q.eq("status", status).gt("attemptedAt", now - DAY))
        .take(5000);
      for (const row of rows) {
        if ((row.channel ?? "sms") !== "sms") continue;
        if (status === "delivered") day.delivered += 1;
        else if (status === "failed") day.failed += 1;
        else if (row.deliveryUnconfirmedAt !== undefined) day.notConfirmed += 1;
        else day.accepted += 1;
      }
    }

    // Selestial's own texts in the last day.
    const codes = await ctx.db
      .query("platformMessages")
      .withIndex("by_kind_queued", (q) => q.eq("kind", "auth_code").gt("queuedAt", now - DAY))
      .take(5000);
    const refusedBy: Record<string, number> = {};
    for (const row of codes) if (row.status === "not_sent") refusedBy[row.refusal ?? "other"] = (refusedBy[row.refusal ?? "other"] ?? 0) + 1;
    let notices = 0;
    let spend = 0;
    for (const kind of ["security_notice", "account_notice", "internal_alert", "no_reply_answer"] as const) {
      const rows = await ctx.db
        .query("platformMessages")
        .withIndex("by_kind_queued", (q) => q.eq("kind", kind).gt("queuedAt", now - DAY))
        .take(5000);
      notices += rows.filter((row) => row.status !== "not_sent").length;
      spend += rows.reduce((sum, row) => sum + (row.providerCost ?? 0), 0);
    }
    spend += codes.reduce((sum, row) => sum + (row.providerCost ?? 0), 0);

    const incidents = [];
    for (const check of TEXTING_CHECKS) {
      const open = await ctx.db
        .query("incidents")
        .withIndex("by_check_resolved", (q) => q.eq("check", check).eq("resolvedAt", 0))
        .take(50);
      for (const row of open) incidents.push({ id: row._id, check, kind: row.kind, title: row.title, severity: row.severity, state: row.state, since: row.openedAt ?? row._creationTime });
    }
    incidents.sort((a, b) => ["critical", "high", "medium", "low"].indexOf(a.severity) - ["critical", "high", "medium", "low"].indexOf(b.severity) || a.since - b.since);

    return {
      telnyx: probe ? { outcome: probe.outcome ?? null, at: probe.at, balanceDollars: probe.balanceUnits !== undefined ? probe.balanceUnits / 10_000 : null, detail: probe.outcome === "ok" ? null : probe.detail } : null,
      queue,
      day,
      platform: {
        codesSent: codes.filter((row) => row.status === "sent" || row.status === "delivered").length,
        codesFailed: codes.filter((row) => row.status === "failed" || row.status === "unconfirmed").length,
        codesRefused: refusedBy,
        notices,
        spendDollars: spend / 10_000,
      },
      incidents,
      now,
    };
  },
});
