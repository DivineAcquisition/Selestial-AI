/**
 * A short, stable fingerprint of a text's exact words: two independent 32-bit FNV-1a hashes over its UTF-8
 * bytes, as 16 hex characters. It only answers "is this the same text as before?", so a check with the
 * provider never repeats a request whose body changed. It is not a secret and not a security hash: the
 * text itself (link tokens included) is never stored.
 */
export function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (const byte of new TextEncoder().encode(text)) {
    a = Math.imul(a ^ byte, 0x01000193) >>> 0;
    b = Math.imul(b ^ byte, 0x01000193) >>> 0;
    b = (b ^ (b >>> 15)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
