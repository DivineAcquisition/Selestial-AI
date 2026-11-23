/**
 * What each communication source can actually give Quality, read from the connections that exist, with no
 * capability claimed that was not checked. Signing in to Selestial is not mailbox access; sending email is
 * not reading it; a phone number is not call access; a call is not its transcript; a transcript is not its
 * recording; reading is not sending. An unbuilt integration is "Not available", never "Connected".
 */
import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { readProfile } from "../../compliance/profile";
import { purposesOf } from "../../inbox/mailboxes";
import { emailProvider } from "../../messaging/email";
import { messagingProvider } from "../../messaging/provider";
import { quoConnectionOf } from "../../quo/route";
import { highLevelApp } from "./highlevel";
import { retentionSettings } from "../../retention/settings";
import { qualitySettings } from "../settings";

export type CapabilityRow = { label: string; state: "available" | "unavailable" | "unknown" | "not_used" | "limited"; note: string };
export type Source = { id: string; name: string; state: "connected" | "needs_attention" | "not_connected" | "not_available" | "checking"; detail: string; lastSuccessAt: number | null; capabilities: CapabilityRow[]; action: { label: string; href: string } | null };

const WORDS = { available: "Available", unavailable: "Not available", unknown: "Not checked yet", not_used: "Not used", limited: "Limited" } as const;
export const CAPABILITY_WORDS = WORDS;

export async function communicationSources(ctx: QueryCtx, company: Doc<"companies">): Promise<Source[]> {
  const out: Source[] = [];
  const profile = await readProfile(ctx, company._id);
  const number = profile.messaging.smsNumber;
  const texting = messagingProvider() !== null;
  out.push({
    id: "texting",
    name: "Your business texting number",
    state: number && texting ? "connected" : "not_connected",
    detail: number ? `Texts to and from ${number}, through Selestial.` : "No texting number is set up yet.",
    lastSuccessAt: null,
    capabilities: [
      { label: "Read texts", state: number ? "limited" : "unavailable", note: "Only a short excerpt of each incoming text is kept; the conversation shows it on the client." },
      { label: "Call details", state: "unavailable", note: "This number carries texts only." },
      { label: "Transcripts", state: "unavailable", note: "No calls, so no transcripts." },
      { label: "Send", state: number && texting ? "available" : "unavailable", note: "Quality's requests to cleaners go through it, under every sending rule." },
    ],
    action: number ? null : { label: "Set up texting", href: "/app/settings/texting" },
  });
  const mailer = emailProvider() !== null;
  out.push({ id: "email", name: "Email from Selestial", state: mailer ? "connected" : "not_connected", detail: "Email sent for the company. Sending is not reading.", lastSuccessAt: null, capabilities: [{ label: "Send", state: mailer ? "available" : "unavailable", note: "Used by Retention for customer messages." }, { label: "Read replies", state: "limited", note: "Only replies to Sales conversations come back here." }], action: null });
  const mailboxes = await ctx.db.query("mailboxConnections").withIndex("by_company", (q) => q.eq("companyId", company._id)).take(20);
  for (const m of mailboxes.filter((x) => x.status !== "disconnected")) {
    const purposes = purposesOf(m);
    const care = purposes.includes("care") && retentionSettings(company).readCareInbox;
    out.push({
      id: `mailbox:${m._id}`,
      name: m.address,
      state: m.status === "connected" ? "connected" : "needs_attention",
      detail: `Connected for ${purposes.join(", ")}.`,
      lastSuccessAt: m.lastSyncAt ?? null,
      capabilities: [
        { label: "Read for quality", state: care ? "limited" : "unavailable", note: care ? "Customers' own new lines reach Retention, which opens cases Quality investigates. The emails are not stored." : purposes.includes("hiring") && purposes.length === 1 ? "Connected for hiring only: never read for anything else." : "Not read for quality evidence." },
        { label: "Send", state: m.canSend ? "available" : "unavailable", note: m.canSend ? "The Owner allowed sending from it." : "Read-only." },
      ],
      action: m.status === "connected" ? null : { label: "Reconnect", href: "/app/settings/integrations" },
    });
  }
  // Quo: the company's one Quo connection (convex/quo.ts), which Quality reads when the Owner turns it on.
  const shared = await quoConnectionOf(ctx, company._id);
  const live = (await ctx.db.query("qualityConnections").withIndex("by_company_provider", (q) => q.eq("companyId", company._id).eq("provider", "quo")).take(5)).find((c) => c.status !== "disconnected");
  const reading = qualitySettings(company).readPhonePlatform;
  if (!shared || shared.status === "disconnected") {
    out.push({ id: "quo", name: "Quo (formerly OpenPhone)", state: "not_connected", detail: "Not connected. Without it, calls and their transcripts are not available to Quality. It is the same connection agents text through.", lastSuccessAt: null, capabilities: [{ label: "Call details", state: "unavailable", note: "Connect Quo to read calls." }, { label: "Transcripts", state: "unavailable", note: "Depends on the Quo plan once connected." }], action: { label: "Connect Quo", href: "/app/settings/integrations/quo" } });
  } else if (!live) {
    out.push({ id: "quo", name: "Quo (formerly OpenPhone)", state: "needs_attention", detail: `Connected for texting${shared.selected.length ? ` on ${shared.selected.length} ${shared.selected.length === 1 ? "number" : "numbers"}` : ""}. Quality isn't reading its calls yet.`, lastSuccessAt: null, capabilities: [{ label: "Call details", state: "unknown", note: "Checked when you turn call reading on." }, { label: "Transcripts", state: "unknown", note: "Checked when you turn call reading on." }, { label: "Recordings", state: "not_used", note: "Selestial never copies recordings or changes recording settings." }], action: { label: "Turn on call reading", href: "/app/agents/quality/playbook" } });
  } else {
    const c = live.capabilities;
    out.push({
      id: "quo",
      name: "Quo (formerly OpenPhone)",
      state: live.status === "connected" ? (reading ? "connected" : "needs_attention") : live.status === "checking" ? "checking" : "needs_attention",
      detail: live.status === "connected" ? (reading ? `Reading calls and texts${live.numbers.length ? ` on ${live.numbers.length} ${live.numbers.length === 1 ? "number" : "numbers"}` : ""}, through the same connection agents text through.` : "Connected; reading for quality evidence is off.") : (live.problem ?? live.status),
      lastSuccessAt: live.lastSuccessAt ?? null,
      capabilities: [
        { label: "Call details", state: c.readCallMetadata, note: "Who called, when, how long, which number." },
        { label: "Transcripts", state: c.readTranscripts, note: c.readTranscripts === "unavailable" ? "Quo returned no transcripts; its plan or settings decide this." : "Read when Quo has finished them, including later revisions." },
        { label: "Quo's summaries", state: c.readSummaries, note: "Shown as Quo's summary, never as anyone's words." },
        { label: "Texts", state: c.readMessages, note: "Incoming texts on the chosen numbers, through Quo's signed notices." },
        { label: "Recordings", state: "not_used", note: "Selestial never copies recordings or changes recording settings." },
        { label: "Send", state: "not_used", note: "Reading sends nothing. Quality's requests to cleaners follow each conversation's own route, which is your Quo number only where you allowed Quality on it." },
      ],
      action: live.status === "expired" ? { label: "Check Quo", href: "/app/settings/integrations/quo" } : !reading ? { label: "Turn on reading", href: "/app/agents/quality/playbook" } : null,
    });
  }
  // HighLevel: Quality's own Marketplace-app installation (convex/qualityHighLevel.ts).
  const hl = (await ctx.db.query("qualityConnections").withIndex("by_company_provider", (q) => q.eq("companyId", company._id).eq("provider", "highlevel")).take(5)).find((c) => c.status !== "disconnected");
  if (!highLevelApp()) {
    out.push({ id: "highlevel", name: "HighLevel", state: "not_available", detail: "Not available yet: Selestial's HighLevel app isn't registered on this deployment.", lastSuccessAt: null, capabilities: [{ label: "Texts and emails", state: "unavailable", note: "Available once the Selestial app is in HighLevel's Marketplace." }, { label: "Call transcriptions", state: "unavailable", note: "Available once the Selestial app is in HighLevel's Marketplace." }], action: null });
  } else if (!hl) {
    out.push({ id: "highlevel", name: "HighLevel", state: "not_connected", detail: "Not connected. Install Selestial's HighLevel app so Quality can read the sub-account's texts, emails and call transcriptions.", lastSuccessAt: null, capabilities: [{ label: "Texts and emails", state: "unavailable", note: "Install the app to read them." }, { label: "Call transcriptions", state: "unavailable", note: "Depends on the HighLevel account once installed." }], action: { label: "Connect HighLevel", href: "/app/agents/quality/playbook" } });
  } else {
    const c = hl.capabilities;
    out.push({
      id: "highlevel",
      name: "HighLevel",
      state: hl.status === "connected" ? (reading ? "connected" : "needs_attention") : hl.status === "checking" ? "checking" : "needs_attention",
      detail: hl.status === "connected" ? (reading ? "Reading the sub-account's texts, emails and calls." : "Installed; reading for quality evidence is off.") : (hl.problem ?? hl.status),
      lastSuccessAt: hl.lastSuccessAt ?? null,
      capabilities: [
        { label: "Texts and emails", state: c.readMessages, note: "Incoming and outgoing, with an email's quoted history left out." },
        { label: "Call details", state: c.readCallMetadata, note: "When, which direction, how long." },
        { label: "Transcriptions", state: c.readTranscripts, note: "HighLevel names no speaker, so each line is marked as not identified." },
        { label: "Instant notices", state: c.webhooks, note: c.webhooks === "available" ? "Signed notices from HighLevel are arriving." : "Shown as available once the first signed notice arrives; until then the ten-minute check reads new messages." },
        { label: "Recordings", state: "not_used", note: "Selestial never fetches call recordings." },
        { label: "Send", state: "not_used", note: "Quality never sends through HighLevel." },
      ],
      action: hl.status === "expired" ? { label: "Install again", href: "/app/agents/quality/playbook" } : !reading ? { label: "Turn on reading", href: "/app/agents/quality/playbook" } : null,
    });
  }
  return out;
}

export type { Id };
