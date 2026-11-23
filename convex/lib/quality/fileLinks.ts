/**
 * Addresses for files uploaded through Quality links that stop working, the same scheme as crew photos
 * (convex/lib/dispatch/photoLinks.ts) under a label of its own, so one kind of address never opens another.
 * An address is minted only for someone the query already allowed to see the case.
 */
import type { Id } from "../../_generated/dataModel";
import { expiryFor } from "../dispatch/photoLinks";

const encoder = new TextEncoder();
const LIFETIME = 40 * 60_000;

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
async function signature(key: string, fileId: string, exp: number): Promise<string> {
  const imported = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(`selestial.qualityfile.v1:${fileId}:${exp}`))));
}

/** Null when this deployment cannot sign: the screen then says the file cannot be opened here, rather than serving a lasting address. */
export async function signedQualityFileUrl(fileId: Id<"qualityFiles">, at: number): Promise<string | null> {
  const key = secret();
  const base = site();
  if (!key || !base) return null;
  const exp = expiryFor(at);
  return `${base}/quality-files/${fileId}?exp=${exp}&sig=${await signature(key, fileId, exp)}`;
}

export async function qualityFileRequestValid(fileId: string, exp: string | null, sig: string | null, now: number): Promise<boolean> {
  const key = secret();
  if (!key || !exp || !sig || !/^\d{10,15}$/.test(exp)) return false;
  const expiry = Number(exp);
  if (expiry <= now || expiry > now + LIFETIME) return false;
  const expected = await signature(key, fileId, expiry);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
