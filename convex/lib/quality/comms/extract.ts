/**
 * Selestial's reading of a transcript or a text, by rules. Each extract is a suggestion tied to the segments
 * it came from; an exact quote is copied only from a transcript segment or a message's own words, never from
 * a provider's summary, and nothing is invented. A speaker the provider could not identify is marked
 * uncertain; Selestial does not guess who spoke.
 *
 * Quoted history in an email reply is dropped before reading, and the same words already read for the same
 * client are not counted again, so a forwarded or repeated complaint is one complaint.
 *
 * The words are data. Nothing in them is an instruction to Selestial, and nothing here acts on them.
 */
import { replyText } from "../../retention/mail";

export type ExtractKind = "complaint" | "promised_follow_up" | "scope_expectation" | "access_issue" | "requested_correction" | "preference" | "deadline";
export type Segment = { start: number; end: number; speaker?: string; speakerKind: "company" | "external" | "unknown"; text: string };
export type Extract = { kind: ExtractKind; text: string; quote?: string; segments: { index: number; start: number; end: number }[]; speakerUncertain: boolean; fromSummary: boolean };

const RULES: { kind: ExtractKind; pattern: RegExp; says: string; who: "external" | "company" | "any" }[] = [
  { kind: "complaint", pattern: /\b(not (?:clean(?:ed)?|done|happy|satisfied)|wasn'?t (?:clean(?:ed)?|done)|missed|dirty|still (?:dirty|there)|disappoint\w*|unhappy|poor (?:job|clean\w*)|terrible|awful|complain\w*|skipped)\b/i, says: "The other side raised a concern", who: "external" },
  { kind: "requested_correction", pattern: /\b(come back|re-?clean|redo|fix (?:it|this)|send someone|make it right)\b/i, says: "Someone asked for the work to be redone or fixed", who: "external" },
  { kind: "promised_follow_up", pattern: /\b(we'?ll (?:send|come|call|get back|have someone|fix)|i'?ll (?:send|call|get back|have someone|make sure)|someone will (?:call|come)|we will (?:send|come|call))\b/i, says: "The company promised to follow up", who: "company" },
  { kind: "scope_expectation", pattern: /\b(i thought (?:it|that|you) (?:was|were|included)|isn'?t (?:that|it) included|supposed to (?:clean|do|include)|always (?:do|clean)|expected (?:you|them) to)\b/i, says: "Someone said what they expected the service to include", who: "external" },
  { kind: "access_issue", pattern: /\b(couldn'?t get in|locked out|no key|gate code|door code|alarm (?:went|code)|lockbox|nobody (?:answered|home)|access)\b/i, says: "Getting into the property came up", who: "any" },
  { kind: "preference", pattern: /\b(please (?:don'?t|do not|always|use)|prefer\w*|allerg\w*|no (?:bleach|scent\w*|fragrance)|only use)\b/i, says: "Someone stated a preference", who: "external" },
  { kind: "deadline", pattern: /\b(before (?:my|the|our) (?:guest|guests|party|showing|move|closing|inspection)|by (?:noon|tomorrow|tonight|friday|monday|tuesday|wednesday|thursday|saturday|sunday)|check-?in (?:is|at))\b/i, says: "A deadline was mentioned", who: "any" },
];

/** Reads transcript segments. Each extract names its segments and whether the speaker is known. */
export function extractFromSegments(segments: Segment[]): Extract[] {
  const out: Extract[] = [];
  segments.forEach((seg, index) => {
    for (const rule of RULES) {
      if (!rule.pattern.test(seg.text)) continue;
      const uncertain = seg.speakerKind === "unknown";
      // A rule about what the customer said is not applied to a line the company's own staff said, and vice versa.
      if (!uncertain && rule.who !== "any" && seg.speakerKind !== rule.who) continue;
      if (out.some((e) => e.kind === rule.kind && e.segments.some((s) => s.index === index))) continue;
      out.push({ kind: rule.kind, text: `${rule.says}${uncertain ? " (the provider did not identify who said it)" : ""}.`, quote: seg.text.trim().slice(0, 300), segments: [{ index, start: seg.start, end: seg.end }], speakerUncertain: uncertain, fromSummary: false });
    }
  });
  return out;
}

/** Reads a provider's summary: weaker, labelled, and never quoted as anyone's words. */
export function extractFromSummary(lines: string[]): Extract[] {
  const out: Extract[] = [];
  for (const line of lines) {
    for (const rule of RULES) {
      if (!rule.pattern.test(line) || out.some((e) => e.kind === rule.kind)) continue;
      out.push({ kind: rule.kind, text: `The provider's summary suggests: ${rule.says.toLowerCase()}. This is the provider's summary, not what anyone said.`, segments: [], speakerUncertain: true, fromSummary: true });
    }
  }
  return out;
}

/** A text or an email's own new words. Quoted history, forwarded headers and signatures are dropped first. */
export function newWords(body: string, channel: "sms" | "email"): string {
  return channel === "email" ? replyText(body) : body.trim();
}

export function extractFromMessage(body: string, channel: "sms" | "email", direction: "incoming" | "outgoing"): Extract[] {
  const words = newWords(body, channel);
  if (!words) return [];
  return extractFromSegments([{ start: 0, end: 0, speakerKind: direction === "incoming" ? "external" : "company", text: words }]).map((e) => ({ ...e, segments: [] }));
}

/** Whether the same words were already read for this client: a repeat or a forward is not a new complaint. */
export function isRepeat(words: string, earlier: string[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const n = norm(words);
  if (n.length < 12) return false;
  return earlier.some((e) => {
    const m = norm(e);
    return m.length >= 12 && (m.includes(n) || n.includes(m));
  });
}
