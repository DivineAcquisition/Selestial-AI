/**
 * Running a REAL job-board notification through Recruiter's reader, for the samples in
 * tests/fixtures/recruiter-real/ (docs/recruiter/07-real-samples.md). A sample is the message exactly as
 * the mailbox received it (a .eml file: headers, a blank line, the body), with personal details redacted.
 *
 * `readSample` answers the four things that matter about a notice, the way the inbox run and intake would
 * decide them, without a database: what kind of mail it is, whose application, which kind of address was
 * found for them, and whether Recruiter would invite them by itself.
 */
import { resolveContact } from "../convex/lib/recruiter/contact";
import { sortEvidence } from "../convex/lib/recruiter/intake";
import { checked, headerEvidence, interpretByRule } from "../convex/lib/recruiter/interpret";
import { addressOf, classifyHeader, unsupportedBoardFor, worthReading, type MessageBody } from "../convex/lib/recruiter/mail";
import { rulesLooksLikeHiring } from "../convex/lib/recruiter/model";
import { USABLE_CONTACT, type Source } from "../convex/lib/recruiter/schema";

function decodeBytes(bytes: number[], charset: string): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(Uint8Array.from(bytes));
  } catch {
    return new TextDecoder().decode(Uint8Array.from(bytes));
  }
}

function fromBase64(data: string, charset: string): string {
  try {
    return decodeBytes([...atob(data.replace(/\s+/g, ""))].map((c) => c.charCodeAt(0)), charset);
  } catch {
    return data;
  }
}

function fromQuotedPrintable(data: string, charset: string): string {
  const bytes: number[] = [];
  const text = data.replace(/=\r?\n/g, "");
  for (let i = 0; i < text.length; i += 1) {
    const hex = text[i] === "=" ? text.slice(i + 1, i + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(...new TextEncoder().encode(text[i]));
  }
  return decodeBytes(bytes, charset);
}

/** RFC 2047 words in a header: =?UTF-8?B?…?= and =?UTF-8?Q?…?=. */
function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset: string, kind: string, data: string) => (kind.toLowerCase() === "b" ? fromBase64(data, charset) : fromQuotedPrintable(data.replace(/_/g, " "), charset)));
}

type Entity = { headers: Map<string, string>; body: string };

function entity(raw: string): Entity {
  const text = raw.replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  const headers = new Map<string, string>();
  // A header continues on the next line when that line starts with a space or a tab. The first of a name wins.
  for (const line of head.replace(/\n[ \t]+/g, " ").split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, decodeWords(line.slice(colon + 1).trim()));
  }
  return { headers, body: split === -1 ? "" : text.slice(split + 2) };
}

function textOf(part: Entity): { plain: string; html: string; attachments: MessageBody["attachments"] } {
  const type = part.headers.get("content-type") ?? "text/plain";
  const out = { plain: "", html: "", attachments: [] as MessageBody["attachments"] };
  const boundary = type.match(/boundary="?([^";]+)"?/i)?.[1];
  if (/^multipart\//i.test(type) && boundary) {
    for (const piece of part.body.split(`--${boundary}`).slice(1)) {
      if (piece.startsWith("--")) break;
      const inner = textOf(entity(piece.replace(/^\n/, "")));
      out.plain += inner.plain;
      out.html += inner.html;
      out.attachments.push(...inner.attachments);
    }
    return out;
  }
  const charset = type.match(/charset="?([^";\s]+)"?/i)?.[1] ?? "utf-8";
  const encoding = (part.headers.get("content-transfer-encoding") ?? "").toLowerCase();
  const disposition = part.headers.get("content-disposition") ?? "";
  const name = (disposition.match(/filename\*?="?([^";]+)"?/i) ?? type.match(/name="?([^";]+)"?/i))?.[1];
  const mime = type.split(";")[0].trim().toLowerCase();
  if (name) {
    // As the Gmail connector does: a plain-text attachment is read, anything else is only listed.
    const text = mime === "text/plain" ? (encoding === "base64" ? fromBase64(part.body, charset) : encoding === "quoted-printable" ? fromQuotedPrintable(part.body, charset) : part.body) : undefined;
    out.attachments.push({ name, contentType: mime, size: part.body.length, ...(text ? { text } : {}) });
    return out;
  }
  const decoded = encoding === "base64" ? fromBase64(part.body, charset) : encoding === "quoted-printable" ? fromQuotedPrintable(part.body, charset) : part.body;
  if (mime === "text/html") out.html = decoded;
  else if (mime.startsWith("text/")) out.plain = decoded;
  return out;
}

/** A .eml file as the message the mailbox connector would hand over. */
export function parseEml(raw: string, id = "sample"): MessageBody {
  const top = entity(raw);
  const { plain, html, attachments } = textOf(top);
  const date = Date.parse(top.headers.get("date") ?? "");
  return { id, from: top.headers.get("from") ?? "", replyTo: top.headers.get("reply-to"), subject: top.headers.get("subject") ?? "", receivedAt: Number.isNaN(date) ? 0 : date, text: (plain || html).trim(), attachments };
}

export type SampleReading = {
  /** The classification the message would be filed under. */
  kind: string;
  source: Source | "unsupported board" | null;
  applicantName: string | null;
  /** direct: the applicant's own address. relay: only the board's forwarding address. none: nothing usable. */
  contactKind: "direct" | "relay" | "none";
  /**
   * Whether Recruiter would email this person without anyone looking, IF the role matches an open hiring
   * need and the Owner set invitations to automatic. A relay counts only once the Owner has confirmed
   * that board's forwarding, which a new company has not, so it is "no" here.
   */
  wouldAutoInvite: "yes" | "no";
};

/** What Recruiter makes of one message, by the rules reader (no model), for a mailbox with this address. */
export async function readSample(message: MessageBody, mailbox = "hiring@company.test"): Promise<SampleReading> {
  const nothing = (kind: string, source: SampleReading["source"] = null): SampleReading => ({ kind, source, applicantName: null, contactKind: "none", wouldAutoInvite: "no" });
  if (addressOf(message.from) === mailbox) return nothing("unrelated");
  const byHeader = classifyHeader(message);
  let known: NonNullable<Parameters<typeof interpretByRule>[1]> | null = null;
  if (byHeader.kind === "board") {
    if (!worthReading(byHeader.classification) || byHeader.classification === "needs_review") return nothing(byHeader.classification, byHeader.source);
    known = { source: byHeader.source, classification: byHeader.classification };
  } else if (!(await rulesLooksLikeHiring({ from: message.from, subject: message.subject })).hiring) {
    // Not from a board Recruiter reads, and the subject is not about applying: never opened.
    return nothing("unrelated", unsupportedBoardFor(addressOf(message.from)) ? "unsupported board" : null);
  }
  const read = checked(interpretByRule(message, known), message);
  if (known) read.classification = known.classification;
  const unsupported = unsupportedBoardFor(addressOf(message.from));
  if (read.classification === "unrelated") return nothing("unrelated", unsupported ? "unsupported board" : null);
  const sorted = sortEvidence(message, read, headerEvidence(message, [mailbox]));
  const contact = resolveContact(sorted.evidence.map((entry) => ({ ...entry, sourceMessageId: "sample" as never })), sorted.source, []);
  const contactKind = contact.status === "direct" ? "direct" : contact.status === "relay" || contact.status === "relay_unverified" ? "relay" : "none";
  return {
    kind: read.classification,
    source: sorted.unsupported ? "unsupported board" : sorted.source,
    applicantName: read.name ?? null,
    contactKind,
    wouldAutoInvite: read.classification === "new_application" && USABLE_CONTACT.includes(contact.status) && !read.forwarded ? "yes" : "no",
  };
}
