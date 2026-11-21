import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Select } from "./select";

const OPTIONS = [
  { value: "access", label: "See my information" },
  { value: "correction", label: "Correct my information" },
];

const hiddenValue = (html: string, name: string) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0].match(/value="([^"]*)"/)?.[1];

describe("Select in a form", () => {
  it("submits an unanswered field as empty, never as an internal marker", () => {
    const html = renderToStaticMarkup(<Select name="subtype" required value={null} onValueChange={() => undefined} options={OPTIONS} emptyLabel="Choose one" />);
    expect(hiddenValue(html, "subtype")).toBe("");
    expect(html).not.toContain("__selestial_empty__");
  });

  it("submits the stored identifier, not the label", () => {
    const html = renderToStaticMarkup(<Select name="subtype" value="correction" onValueChange={() => undefined} options={OPTIONS} emptyLabel="Choose one" />);
    expect(hiddenValue(html, "subtype")).toBe("correction");
  });

  it("keeps a saved value that is no longer offered, and says so", () => {
    const html = renderToStaticMarkup(<Select name="subtype" value="retired" onValueChange={() => undefined} options={OPTIONS} />);
    expect(hiddenValue(html, "subtype")).toBe("retired");
    expect(html).toContain("No longer available");
  });
});
