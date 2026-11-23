/**
 * @vitest-environment edge-runtime
 *
 * Files uploaded through a Quality link are opened only through an address this deployment signed, for one
 * file, for a short time. Scenario 16: a copied address stops working, and one file's address opens no other.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Id } from "../../_generated/dataModel";
import { qualityFileRequestValid, signedQualityFileUrl } from "./fileLinks";

const FILE = "k57abcdefghijklmnop" as Id<"qualityFiles">;
const NOW = Date.UTC(2026, 10, 22, 15);

describe("signed Quality file addresses", () => {
  beforeEach(() => {
    process.env.ACTION_LINK_SECRET = "s".repeat(40);
    process.env.CONVEX_SITE_URL = "https://example.convex.site";
  });
  afterEach(() => {
    delete process.env.ACTION_LINK_SECRET;
    delete process.env.CONVEX_SITE_URL;
  });

  const parts = async () => {
    const url = new URL((await signedQualityFileUrl(FILE, NOW))!);
    return { url, exp: url.searchParams.get("exp"), sig: url.searchParams.get("sig") };
  };

  it("opens the one file it was signed for, until it expires", async () => {
    const { url, exp, sig } = await parts();
    expect(url.pathname).toBe(`/quality-files/${FILE}`);
    expect(await qualityFileRequestValid(FILE, exp, sig, NOW)).toBe(true);
    expect(await qualityFileRequestValid(FILE, exp, sig, Number(exp) + 1)).toBe(false);
  });

  it("opens nothing else: another file, a changed expiry, a changed signature, or no signature", async () => {
    const { exp, sig } = await parts();
    expect(await qualityFileRequestValid("k57otherfileabcdefg", exp, sig, NOW)).toBe(false);
    expect(await qualityFileRequestValid(FILE, String(Number(exp) + 60_000), sig, NOW)).toBe(false);
    expect(await qualityFileRequestValid(FILE, exp, `${sig!.slice(0, -1)}A`, NOW)).toBe(false);
    expect(await qualityFileRequestValid(FILE, exp, null, NOW)).toBe(false);
  });

  it("refuses an expiry further out than an address is ever minted for", async () => {
    const { sig } = await parts();
    expect(await qualityFileRequestValid(FILE, String(NOW + 24 * 3_600_000), sig, NOW)).toBe(false);
  });

  it("mints no lasting address when the deployment cannot sign", async () => {
    delete process.env.ACTION_LINK_SECRET;
    expect(await signedQualityFileUrl(FILE, NOW)).toBeNull();
    expect(await qualityFileRequestValid(FILE, String(NOW + 60_000), "x", NOW)).toBe(false);
  });
});
