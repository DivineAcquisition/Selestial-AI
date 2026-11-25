import { describe, expect, it } from "vitest";

import { appearanceIsDefault, choicesFrom, draftFrom, draftProblems, resetAppearance } from "./email-branding";
import { menuSectionForPath, searchSections, sectionForPath } from "./settings";

describe("the email branding form", () => {
  it("round-trips saved choices, empty fields meaning the company's own details", () => {
    const draft = draftFrom({ senderName: "Bay Area Pros", logoSource: "company", accent: "#0B5D3B", header: "dark", layout: "banner", logoAlign: "center", signature: { include: true, showAddress: false, phone: "(415) 555-0134" } });
    expect(draft.button).toBe("");
    const choices = choicesFrom({ ...draft, signature: { ...draft.signature, website: "   " } });
    expect(choices).toMatchObject({ senderName: "Bay Area Pros", accent: "#0B5D3B", button: undefined, header: "dark", signature: { phone: "(415) 555-0134", website: undefined, showAddress: false } });
  });

  it("resets only the appearance", () => {
    const draft = { ...draftFrom(null), senderName: "Keep me", accent: "#0B5D3B", layout: "letter" as const };
    const reset = resetAppearance(draft);
    expect(reset).toMatchObject({ senderName: "Keep me", accent: "", layout: "classic" });
    expect(appearanceIsDefault(reset)).toBe(true);
    expect(appearanceIsDefault(draft)).toBe(false);
  });

  it("shows the server's own words for a problem before saving", () => {
    expect(draftProblems({ ...draftFrom(null), accent: "#FFFF66" })[0]).toMatch(/too light/);
    expect(draftProblems(draftFrom(null))).toEqual([]);
  });

  it("lives under Email & texting and is found by search", () => {
    expect(sectionForPath("/app/settings/email-branding")?.id).toBe("email-branding");
    expect(menuSectionForPath("/app/settings/email-branding")?.id).toBe("messaging");
    expect(searchSections("reply address").map((s) => s.id)).toContain("email-branding");
  });
});
