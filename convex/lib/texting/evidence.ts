/**
 * Evidence files: what may be uploaded, and the addresses that let someone allowed to see a file open it
 * for a short while.
 *
 * Files are kept in Convex storage, which is private: nothing is reachable without an address Selestial
 * makes. Each address is signed (HMAC with ACTION_LINK_SECRET under its own label, so it can never stand in
 * for another kind of link) and stops working within 15 minutes. A deployment that cannot sign gives no
 * address at all rather than a permanent one. Signed addresses are returned to the caller only; they are
 * never written to the event log, a notification or analytics.
 */
import { checkFile } from "../agreements/upload";

export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
/** Screenshots, PDFs and plain text. Word files and other formats are refused: carriers' reviewers read these. */
export const EVIDENCE_TYPES = ["image/png", "image/jpeg", "application/pdf", "text/plain"] as const;
export const EVIDENCE_ACCEPTED = "PNG or JPEG screenshot, PDF, or plain text, up to 10 MB";

/** Checks an evidence file by its declared type, its size and its own first bytes. */
export function checkEvidenceFile(input: { name: string; contentType: string; size: number; head: Uint8Array }): { ok: true; contentType: string } | { ok: false; why: string } {
  if (input.size > EVIDENCE_MAX_BYTES) return { ok: false, why: `The file is larger than ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB.` };
  const checked = checkFile(input);
  if (!checked.ok) return { ok: false, why: checked.why.replace(/Accepted: .*$/, `Accepted: ${EVIDENCE_ACCEPTED}.`) };
  if (!(EVIDENCE_TYPES as readonly string[]).includes(checked.contentType)) return { ok: false, why: `That file type is not accepted for evidence. Accepted: ${EVIDENCE_ACCEPTED}.` };
  return { ok: true, contentType: checked.contentType };
}

const MINUTE = 60_000;
const LIFETIME = 15 * MINUTE;
const BUCKET = 5 * MINUTE;
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function secret(): string | null {
  const value = process.env.ACTION_LINK_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}

function site(): string | null {
  const value = process.env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
  return value && /^https?:\/\//.test(value) ? value : null;
}

async function signature(key: string, id: string, exp: number): Promise<string> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(`selestial.texting-evidence.v1:${id}:${exp}`))));
}

export function evidenceLinksReady(): boolean {
  return secret() !== null && site() !== null;
}

/** A signed address for one evidence file that stops working within 15 minutes, or null if this deployment can't sign. */
export async function signedEvidenceUrl(evidenceId: string, now: number): Promise<{ url: string; expiresAt: number } | null> {
  const key = secret();
  const base = site();
  if (!key || !base) return null;
  const exp = Math.floor(now / BUCKET) * BUCKET + LIFETIME;
  return { url: `${base}/texting-evidence/${evidenceId}?exp=${exp}&sig=${await signature(key, evidenceId, exp)}`, expiresAt: exp };
}

/** Whether a request carries a valid, unexpired signature. Every failure looks the same. */
export async function evidenceRequestValid(evidenceId: string, exp: string | null, sig: string | null, now: number): Promise<boolean> {
  const key = secret();
  if (!key || !exp || !sig || !/^\d{10,15}$/.test(exp)) return false;
  const expiry = Number(exp);
  if (expiry <= now || expiry > now + LIFETIME + BUCKET) return false;
  const expected = await signature(key, evidenceId, expiry);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** The exact words an owner agrees to before a review copy can be shown outside Selestial. */
export const REVIEW_COPY_WORDING =
  "I approve showing this review copy at a public address so carrier reviewers can see how people agree to our texts. It is a blank or redacted copy: it shows no customer's, cleaner's or applicant's name, signature, phone number, email or address. I can withdraw it at any time.";

/** A random path part for a public review copy: 32 url-safe characters. */
export function reviewToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
