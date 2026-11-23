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
  const shared = emailProvider() !== null;
  out.push({ id: "email", name: "Email from Selestial", state: shared ? "connected" : "not_connected", detail: "Email sent for the company. Sending is not reading.", lastSuccessAt: null, capabilities: [{ label: "Send", state: shared ? "available" : "unavailable", note: "Used by Retention for customer messages." }, { label: "Read replies", state: "limited", note: "Only replies to Sales conversations come back here." }], action: null });
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
  const quo = await ctx.db.query("qualityConnections").withIndex("by_company_provider", (q) => q.eq("companyId", company._id).eq("provider", "quo")).take(5);
  const live = quo.find((c) => c.status !== "disconnected");
  const reading = qualitySettings(company).readPhonePlatform;
  if (!live) {
    out.push({ id: "quo", name: "Quo (formerly OpenPhone)", state: "not_connected", detail: "Not connected. Without it, calls and their transcripts are not available to Quality.", lastSuccessAt: null, capabilities: [{ label: "Call details", state: "unavailable", note: "Connect Quo to read calls." }, { label: "Transcripts", state: "unavailable", note: "Depends on the Quo plan once connected." }], action: { label: "Connect Quo", href: "/app/agents/quality/playbook" } });
  } else {
    const c = live.capabilities;
    out.push({
      id: "quo",
      name: "Quo (formerly OpenPhone)",
      state: live.status === "connected" ? (reading ? "connected" : "needs_attention") : live.status === "checking" ? "checking" : "needs_attention",
      detail: live.status === "connected" ? (reading ? `Reading calls and texts${live.numbers.length ? ` on ${live.numbers.length} ${live.numbers.length === 1 ? "number" : "numbers"}` : ""}.` : "Connected; reading for quality evidence is off.") : (live.problem ?? live.status),
      lastSuccessAt: live.lastSuccessAt ?? null,
      capabilities: [
        { label: "Call details", state: c.readCallMetadata, note: "Who called, when, how long, which number." },
        { label: "Transcripts", state: c.readTranscripts, note: c.readTranscripts === "unavailable" ? "Quo returned no transcripts; its plan or settings decide this." : "Read when Quo has finished them, including later revisions." },
        { label: "Quo's summaries", state: c.readSummaries, note: "Shown as Quo's summary, never as anyone's words." },
        { label: "Texts", state: c.readMessages, note: "Incoming texts on Quo numbers, through Quo's signed notices." },
        { label: "Recordings", state: "not_used", note: "Selestial never copies recordings or changes recording settings." },
        { label: "Send", state: "not_used", note: "Quality does not send through Quo." },
      ],
      action: live.status === "expired" ? { label: "Reconnect Quo", href: "/app/agents/quality/playbook" } : !reading ? { label: "Turn on reading", href: "/app/agents/quality/playbook" } : null,
    });
  }
  return out;
}

export type { Id };
