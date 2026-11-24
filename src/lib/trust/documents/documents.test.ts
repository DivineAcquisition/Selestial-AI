import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DOCUMENT_KINDS, DOCUMENT_VERSIONS } from "../../../../convex/lib/trust/documents";
import { DOCUMENT_TEXTS, textFor } from "./index";

const LINK = /\[([^\]]+)\]\(([^)]+)\)/g;

/** The page a site path is served from, under src/app. */
const pageExists = (href: string) => existsSync(path.join(process.cwd(), "src/app", href.split(/[?#]/)[0], "page.tsx"));

describe("the public documents", () => {
  it("has text for every listed version, and a page for every kind", () => {
    for (const version of DOCUMENT_VERSIONS) expect(DOCUMENT_TEXTS[version.id], version.id).toBeDefined();
    for (const kind of DOCUMENT_KINDS) expect(pageExists(`/${kind}`), kind).toBe(true);
  });

  it("keeps links out of the lead, where they are not turned into links", () => {
    for (const kind of DOCUMENT_KINDS) expect(textFor(kind).lead, kind).not.toMatch(LINK);
  });

  it("links only to pages that exist, or to an email address", () => {
    for (const kind of DOCUMENT_KINDS) {
      const paragraphs = textFor(kind).sections.flatMap((section) => section.blocks.flatMap((block) => ("p" in block ? [block.p] : "list" in block ? block.list : "note" in block ? [block.note] : [])));
      for (const text of paragraphs) {
        for (const [, , href] of text.matchAll(LINK)) {
          if (href.startsWith("mailto:")) continue;
          expect(pageExists(href), `${kind}: ${href}`).toBe(true);
        }
      }
    }
  });

  it("states the EULA's license, restrictions and ownership of output, and defers to the Terms", () => {
    const eula = textFor("eula");
    const all = JSON.stringify(eula.sections);
    expect(eula.sections.map((section) => section.id)).toEqual(expect.arrayContaining(["license", "restrictions", "your-content-and-output", "our-property-and-feedback", "warranty-liability-law"]));
    expect(all).toContain("non-exclusive, non-transferable, non-sublicensable and revocable license");
    expect(all).toMatch(/benchmarks/);
    expect(all).toMatch(/scrape/);
    expect(all).toContain("we assign them to your business");
    expect(all).toContain("the Terms of Service apply");
  });
});
