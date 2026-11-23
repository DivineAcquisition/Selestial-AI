/**
 * A worker's tax document, prepared in the background. There is no "upload your tax form" step.
 *
 *  - Which document, if any, is decided from the relationship and where the company works: an independent
 *    contractor of a US company certifies a substitute Form W-9; an employee completes withholding forms with
 *    the company's payroll; a subcontractor worker is paid through their own company. Anything else is
 *    "not prepared in Selestial", said plainly to the office and never to the worker as a task.
 *  - Only what is genuinely missing is asked, inside the pay step, after the one-time code. The legal name is
 *    prefilled from the record. The taxpayer number is sealed (AES-256-GCM, TAX_ID_KEY) bound to the worker,
 *    and only its last four digits are ever shown. Without a key nothing is collected.
 *  - The worker's own certification is required: their typed name against the exact words. Nobody signs for
 *    them, and a document is completed only once it was actually made and stored. Preparing is not complete.
 *  - The number never appears in a URL, a message, an event, a log, or anything sent to a model.
 */
import type { Doc } from "../../_generated/dataModel";

export type TaxPlan = { form: "w9" } | { form: "none"; reason: string };

/** IANA zones of the United States, for companies that have not said where they work. */
const US_ZONES = /^(America\/(New_York|Detroit|Kentucky\/.+|Indiana\/.+|Chicago|Menominee|North_Dakota\/.+|Denver|Boise|Phoenix|Los_Angeles|Anchorage|Juneau|Sitka|Metlakatla|Yakutat|Nome|Adak)|Pacific\/Honolulu|US\/.+)$/;

export function isUsCompany(company: Pick<Doc<"companies">, "timezone">): boolean {
  return US_ZONES.test(company.timezone);
}

export function taxPlan(company: Pick<Doc<"companies">, "timezone">, cleaner: Pick<Doc<"cleaners">, "engagement">): TaxPlan {
  if (cleaner.engagement === "subcontractor") return { form: "none", reason: "Paid through their subcontractor company, which handles its own tax documents." };
  if (cleaner.engagement === "employee") return { form: "none", reason: "Employees complete tax withholding forms with the company's payroll, outside Selestial." };
  if (!isUsCompany(company)) return { form: "none", reason: "Tax documents for this company's location are not prepared in Selestial. Collect them the way your accountant advises." };
  return { form: "w9" };
}

/**
 * The certification on Form W-9, Part II, in the worker's words. It is shown in full and stored with the
 * signature, so what they certified can always be read back.
 */
export const W9_CERTIFICATION =
  "Under penalties of perjury, I certify that: 1. The number shown is my correct taxpayer identification number (or I am waiting for a number to be issued to me); and 2. I am not subject to backup withholding because (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue Service (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has notified me that I am no longer subject to backup withholding; and 3. I am a U.S. citizen or other U.S. person; and 4. The FATCA code(s) entered (if any) indicating that I am exempt from FATCA reporting is correct. I am signing this electronically by typing my name.";

export const TIN_WORDS = { ssn: "Social Security number", ein: "Employer Identification Number", itin: "Individual Taxpayer Identification Number" } as const;

/** Nine digits, with the shapes the IRS never issues refused. Returns the digits, or null. */
export function cleanTin(type: "ssn" | "ein" | "itin", value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 9 || /^(\d)\1{8}$/.test(digits)) return null;
  if (type === "ssn" && (digits.startsWith("000") || digits.startsWith("666") || digits.startsWith("9") || digits.slice(3, 5) === "00" || digits.slice(5) === "0000")) return null;
  if (type === "itin" && !digits.startsWith("9")) return null;
  if (type === "ein" && digits.startsWith("00")) return null;
  return digits;
}

export const US_STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI AS MP".split(" "));

// ── Sealing the number ───────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function key(): Promise<CryptoKey | null> {
  const raw = process.env.TAX_ID_KEY?.trim();
  if (!raw) return null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(raw);
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function taxKeyConfigured(): Promise<boolean> {
  return (await key()) !== null;
}

export async function sealTin(value: string, boundTo: string): Promise<string | null> {
  const k = await key();
  if (!k) return null;
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`tax:${boundTo}`) }, k, encoder.encode(value)));
  return `${toBase64(iv)}.${toBase64(sealed)}`;
}

export async function unsealTin(sealed: string, boundTo: string): Promise<string | null> {
  const k = await key();
  const [iv, data] = sealed.split(".");
  if (!k || !iv || !data) return null;
  try {
    return decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv), additionalData: encoder.encode(`tax:${boundTo}`) }, k, fromBase64(data)));
  } catch {
    return null;
  }
}

// ── The document ─────────────────────────────────────────────────────────────────────────────────

const formatTin = (type: "ssn" | "ein" | "itin", digits: string) => (type === "ein" ? `${digits.slice(0, 2)}-${digits.slice(2)}` : `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`);

/** The substitute W-9 as text, from the worker's own answers and certification. Rendered to PDF by the caller. */
export function w9Markdown(input: { company: string; doc: Doc<"taxDocuments">; tin: string; timezone: string }): string {
  const d = input.doc;
  const cert = d.certification!;
  const when = new Date(cert.at).toLocaleString("en-US", { timeZone: input.timezone, dateStyle: "long", timeStyle: "short" });
  return [
    "# Substitute Form W-9",
    "Request for Taxpayer Identification Number and Certification",
    "",
    `Requested by: ${input.company}`,
    "",
    "## Taxpayer",
    `Name (as shown on your income tax return): ${d.legalName}`,
    ...(d.businessName ? [`Business name: ${d.businessName}`] : []),
    "Federal tax classification: Individual / sole proprietor",
    `Address: ${d.address!.line1}, ${d.address!.city}, ${d.address!.state} ${d.address!.postalCode}`,
    "",
    "## Taxpayer identification number",
    `${TIN_WORDS[d.tinType!]}: ${formatTin(d.tinType!, input.tin)}`,
    "",
    "## Certification",
    W9_CERTIFICATION,
    "",
    `Signed electronically by typing: ${cert.typedName}`,
    `Date: ${when}`,
    "",
    "Collected through the worker's own secure onboarding link after a one-time code. Selestial did not complete or sign this form for them.",
  ].join("\n");
}

/** What the office sees about the document, in words. */
export const TAX_STATE_WORDS: Record<Doc<"taxDocuments">["status"], string> = {
  awaiting_information: "Waiting for their details",
  awaiting_confirmation: "Waiting for their certification",
  preparing: "Being prepared",
  completed: "Completed",
  failed: "Could not be prepared",
  not_applicable: "Not prepared in Selestial",
};
