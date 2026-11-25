/**
 * Company communications: a cleaning company writing to its customers, applicants and cleaners, sent from
 * its own name "via Selestial" (docs/email/00-architecture.md §2–3). The company's logo and accent lead;
 * Selestial appears only in the footer.
 *
 * When the same message goes from the company's connected Gmail instead, it isn't templated at all:
 * `conversationEmail` writes it as a person would, in the existing thread.
 */
import { action, alert, amounts, checklist, escapeHtml, facts, FONT, lead, oneLine, paragraph, renderEmail, signature, textLink, title, TOKENS, webAddress, type Block, type Identity } from "../kit";
import type { ResolvedBranding } from "../branding";
import { dayOf, firstName, money, timeOf, when, type Email } from "./shared";

/** The company as its customers know it. Everything here comes from the company's own settings. */
export type CompanyBrand = {
  name: string;
  logoUrl?: string | null;
  accent?: string | null;
  /** The mailing address for the footer, when the company has one on record. */
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
};

function identity(brand: CompanyBrand): Identity {
  return { kind: "company", name: brand.name, logoUrl: brand.logoUrl, accent: brand.accent, viaSelestial: true, address: brand.address };
}

function finish(brand: CompanyBrand, input: { subject: string; preheader: string; blocks: Block[]; reason: string; unsubscribeUrl?: string | null }): Email {
  const { html, text } = renderEmail({ identity: identity(brand), preheader: input.preheader, blocks: input.blocks, footer: { reason: input.reason, unsubscribeUrl: input.unsubscribeUrl } });
  return { subject: oneLine(input.subject), preheader: oneLine(input.preheader), html, text };
}

function signOff(brand: CompanyBrand, from?: string | null): Block {
  return signature({ name: from ?? null, company: oneLine(brand.name), phone: brand.phone, email: brand.email, website: brand.website });
}

// ── Booking confirmation ─────────────────────────────────────────────────────────────────────────

export function bookingConfirmationEmail(input: {
  brand: CompanyBrand;
  customerName?: string | null;
  service: string;
  startsAt: number;
  arrivalWindowMinutes?: number | null;
  timezone?: string;
  address?: string | null;
  lines: { label: string; amountCents: number }[];
  totalCents: number;
  currency?: string;
  /** What's already paid, when a deposit was taken. */
  paidCents?: number | null;
  manageUrl: string;
  /** The company's own policy, as it wrote it. */
  policy?: string | null;
  fromName?: string | null;
}): Email {
  const company = oneLine(input.brand.name);
  const first = firstName(input.customerName);
  const date = when(input.startsAt, input.timezone);
  const window = input.arrivalWindowMinutes ? `Within ${input.arrivalWindowMinutes} minutes of ${timeOf(input.startsAt, input.timezone)}` : null;
  const due = input.totalCents - (input.paidCents ?? 0);
  return finish(input.brand, {
    subject: `You're booked: ${oneLine(input.service)} on ${dayOf(input.startsAt, input.timezone).replace(/, \d{4}$/, "")}`,
    preheader: `${company} will see you ${date}. Your details and how to make changes are inside.`,
    blocks: [
      title(first ? `You're booked, ${first}` : "You're booked"),
      lead(`Thanks for booking with ${company}. Here's what we have down.`),
      facts(
        [
          { label: "Service", value: oneLine(input.service) },
          { label: "When", value: date },
          { label: "Arrival", value: window },
          { label: "Where", value: input.address ?? null },
        ],
        "Your visit",
      ),
      amounts({
        heading: "Price",
        lines: [...input.lines.map((l) => ({ label: l.label, amount: money(l.amountCents, input.currency) })), ...(input.paidCents ? [{ label: "Paid", amount: `−${money(input.paidCents, input.currency)}`, muted: true }] : [])],
        total: { label: input.paidCents ? "Due after the visit" : "Total", amount: money(Math.max(0, due), input.currency) },
      }),
      action({ label: "View or change your booking", url: input.manageUrl, accent: input.brand.accent }),
      input.policy ? paragraph(input.policy) : { html: "", text: "" },
      paragraph("Questions? Just reply to this email."),
      signOff(input.brand, input.fromName),
    ],
    reason: `You're getting this because you booked a visit with ${company}.`,
  });
}

// ── Proposal delivery ────────────────────────────────────────────────────────────────────────────

export function proposalDeliveryEmail(input: {
  brand: CompanyBrand;
  recipientName?: string | null;
  proposalTitle: string;
  preparedBy?: string | null;
  note?: string | null;
  lines: { label: string; amountCents: number; cadence?: string | null }[];
  totalCents: number;
  totalLabel?: string;
  currency?: string;
  validUntil?: number | null;
  timezone?: string;
  reviewUrl: string;
}): Email {
  const company = oneLine(input.brand.name);
  const first = firstName(input.recipientName);
  const proposal = oneLine(input.proposalTitle);
  return finish(input.brand, {
    subject: `${company} sent you a proposal: ${proposal}`,
    preheader: `${money(input.totalCents, input.currency)}${input.validUntil ? `, valid until ${dayOf(input.validUntil, input.timezone)}` : ""}. Review it and reply with any questions.`,
    blocks: [
      title(first ? `${first}, here's your proposal` : "Here's your proposal"),
      lead(input.note ?? `${company} put together a proposal for ${proposal}. You can read it in full, ask for changes, or accept it online.`),
      amounts({
        heading: proposal,
        lines: input.lines.map((l) => ({ label: l.cadence ? `${l.label} · ${l.cadence}` : l.label, amount: money(l.amountCents, input.currency) })),
        total: { label: input.totalLabel ?? "Total", amount: money(input.totalCents, input.currency) },
        note: input.validUntil ? `Prices are held until ${dayOf(input.validUntil, input.timezone)}.` : null,
      }),
      action({ label: "Review the proposal", url: input.reviewUrl, accent: input.brand.accent }),
      paragraph("Opening the proposal doesn't accept it. You'll see every detail first and choose what to do."),
      signOff(input.brand, input.preparedBy),
    ],
    reason: `You're getting this because you asked ${company} for a proposal.`,
  });
}

// ── Applicant invitation ─────────────────────────────────────────────────────────────────────────

export function applicantInvitationEmail(input: {
  brand: CompanyBrand;
  applicantName?: string | null;
  role: string;
  step: "screening" | "interview";
  /** For an interview: when it's set, and where or how. */
  at?: number | null;
  timezone?: string;
  where?: string | null;
  minutes?: number | null;
  url: string;
  expiresAt?: number | null;
  fromName?: string | null;
  whatToBring?: string[];
}): Email {
  const company = oneLine(input.brand.name);
  const first = firstName(input.applicantName);
  const role = oneLine(input.role);
  const interview = input.step === "interview";
  return finish(input.brand, {
    subject: interview ? `Interview for the ${role} role at ${company}` : `Next step for the ${role} role at ${company}`,
    preheader: interview && input.at ? `${when(input.at, input.timezone)}. Confirm or pick another time.` : `A few short questions${input.minutes ? ` (about ${input.minutes} minutes)` : ""} so we can get to know you.`,
    blocks: [
      title(first ? `Thanks for applying, ${first}` : "Thanks for applying"),
      lead(interview ? `We'd like to meet you about the ${role} role.` : `We'd like to learn a bit more about you for the ${role} role. The next step is a few short questions you can answer on your phone.`),
      facts(
        [
          { label: "Role", value: role },
          { label: interview ? "When" : "Takes", value: interview ? (input.at ? when(input.at, input.timezone) : null) : input.minutes ? `About ${input.minutes} minutes` : null },
          { label: "Where", value: interview ? input.where ?? null : null },
          { label: "Link works until", value: input.expiresAt ? dayOf(input.expiresAt, input.timezone) : null },
        ],
        interview ? "Your interview" : "Next step",
      ),
      input.whatToBring?.length ? checklist({ heading: "Have these ready", items: input.whatToBring.map((t) => ({ text: t, state: "open" as const })) }) : { html: "", text: "" },
      action({ label: interview ? "Confirm or change the time" : "Answer the questions", url: input.url, accent: input.brand.accent }),
      paragraph("If you have a question, reply to this email and it will reach the hiring team."),
      signOff(input.brand, input.fromName ?? `${company} Hiring Team`),
    ],
    reason: `You're getting this because you applied to ${company}.`,
  });
}

// ── Connected-inbox conversation ─────────────────────────────────────────────────────────────────

/**
 * A message sent from the company's own Gmail, in the conversation's thread. Written like a person:
 * paragraphs, at most one link, and the sender's short signature. No logo, no frame, no footer.
 */
export function conversationEmail(input: { paragraphs: string[]; link?: { label: string; url: string } | null; signature: { name?: string | null; company: string; phone?: string | null } }): { html: string; text: string } {
  const lines = input.paragraphs.map((p) => p.trim()).filter(Boolean);
  const link = input.link ? textLink({ label: input.link.label, url: input.link.url }) : null;
  const sig = [input.signature.name, input.signature.company, input.signature.phone].filter((l): l is string => Boolean(l && l.trim())).map(oneLine);
  const para = (html: string) => `<p style="margin:0 0 14px 0;">${html}</p>`;
  const html = `<div style="font-family:${FONT};font-size:15px;line-height:23px;color:${TOKENS.text};">${lines.map((l) => para(escapeHtml(l).replace(/\n/g, "<br>"))).join("")}${link?.html ?? ""}<p style="margin:18px 0 0 0;color:${TOKENS.secondary};">${sig.map(escapeHtml).join("<br>")}</p></div>`;
  const text = `${[...lines, link?.text ?? "", sig.join("\n")].filter(Boolean).join("\n\n")}\n`;
  return { html, text };
}

// ── A company's written message ──────────────────────────────────────────────────────────────────

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** One paragraph of a person's text: escaped, line breaks kept, and web addresses made into links in the company's colour. */
function letterParagraph(text: string, link: string = TOKENS.violetDeep): Block {
  let html = "";
  let last = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const url = match[0];
    html += escapeHtml(text.slice(last, match.index));
    html += `<a href="${escapeHtml(url)}" target="_blank" style="color:${link};text-decoration:underline;word-break:break-all;" class="sx-link">${escapeHtml(url)}</a>`;
    last = (match.index ?? 0) + url.length;
  }
  html += escapeHtml(text.slice(last));
  return { html: `<p style="margin:0;font-family:${FONT};font-size:15px;line-height:24px;color:${TOKENS.text};" class="sx-text">${html.replace(/\n/g, "<br>")}</p>`, text };
}

/** The signature under a message: an optional closing line, then who it's from and how to reach them. */
function brandSignature(branding: ResolvedBranding): Block[] {
  const sig = branding.signature;
  if (!sig.include) return [];
  const closing = sig.closing ? paragraph(sig.closing) : { html: "", text: "" };
  const block = signature({ name: sig.name ?? branding.companyName, company: sig.name ? branding.companyName : "", phone: sig.phone, email: sig.supportEmail, website: webAddress(sig.website) });
  return [closing, block];
}

/** A note at the top of a test email, so nobody mistakes it for a real message. */
function testNote(): Block {
  return alert({ tone: "info", title: "This is a test of your email branding", body: "The message below is sample content, not a real booking, quote or invoice. Customers see the same design, with their own details." });
}

/**
 * A message a company's team or agent wrote (an invoice, a reminder, a reply), set in the company's
 * branding (convex/lib/email/branding.ts): its logo and colours, its layout, the words exactly as written,
 * its signature, and a footer saying why the person got it and that it was sent via Selestial. Branding
 * never adds to or changes the words, and can't remove the footer.
 *
 * This is the one renderer for company email through Selestial: real sends, test emails and the settings
 * preview all call it.
 */
export function brandedLetter(input: { branding: ResolvedBranding; text: string; reason: string; preheader?: string; test?: boolean; unsubscribeUrl?: string | null }): { html: string; text: string } {
  const b = input.branding;
  const paragraphs = input.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const first = paragraphs.find((p) => !/https?:\/\//.test(p)) ?? paragraphs[0] ?? "";
  const identity: Identity = { kind: "company", name: b.companyName, logoUrl: b.logoUrl, accent: b.accent, viaSelestial: true, address: b.address, look: { layout: b.layout, header: b.header, logoAlign: b.logoAlign } };
  const signed = brandSignature(b);
  const blocks = [...(input.test ? [testNote()] : []), ...paragraphs.map((p) => letterParagraph(p, b.accent)), ...signed];
  const { html } = renderEmail({ identity, preheader: input.preheader ?? first.slice(0, 140), blocks, footer: { reason: input.reason, unsubscribeUrl: input.unsubscribeUrl } });
  // The plain-text version is exactly what they wrote, then the signature and the footer.
  const footer = `${oneLine(input.reason)}\n${b.companyName} · sent via Selestial${b.address ? ` · ${b.address}` : ""}`;
  const sigText = signed.map((x) => x.text).filter(Boolean).join("\n\n");
  const testText = input.test ? `TEST EMAIL: sample content only.\n\n` : "";
  return { html, text: `${testText}${paragraphs.join("\n\n")}${sigText ? `\n\n${sigText}` : ""}\n\n—\n\n${footer}\n` };
}

/**
 * The same frame from a company's basic brand, with no signature: what company mail looked like before
 * a company set its email branding. Kept for callers that have only a CompanyBrand.
 */
export function companyLetter(input: { brand: CompanyBrand; text: string; reason: string; preheader?: string }): { html: string; text: string } {
  const paragraphs = input.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const first = paragraphs.find((p) => !/https?:\/\//.test(p)) ?? paragraphs[0] ?? "";
  const { html } = renderEmail({ identity: identity(input.brand), preheader: input.preheader ?? first.slice(0, 140), blocks: paragraphs.map((p) => letterParagraph(p)), footer: { reason: input.reason } });
  const footer = `${oneLine(input.reason)}\n${oneLine(input.brand.name)} · sent via Selestial${input.brand.address ? ` · ${oneLine(input.brand.address)}` : ""}`;
  return { html, text: `${paragraphs.join("\n\n")}\n\n—\n\n${footer}\n` };
}
