import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BUILT } from "../../../convex/lib/integrations";
import { logoFile } from "@/components/app/integration-mark";
import { INTEGRATIONS as CATALOG } from "@/lib/app/integrations";
import { INTEGRATIONS as HOME } from "./content";
import { integrationsByCategory } from "./integrations-page";

const SELESTIAL_OWN = new Set(["texting-number"]);
const logoExists = (id: string) => {
  const file = logoFile(id);
  return file !== null && existsSync(join(process.cwd(), "public", "integrations", file));
};

describe("the public Integrations page", () => {
  const live = integrationsByCategory(true).flatMap((category) => category.items);
  const planned = integrationsByCategory(false).flatMap((category) => category.items);

  it("lists every integration in the product exactly once", () => {
    expect([...live, ...planned].map((item) => item.id).sort()).toEqual(CATALOG.map((item) => item.id).sort());
  });

  it("calls an integration live exactly when the server lists it as built", () => {
    for (const item of live) expect((BUILT as readonly string[]).includes(item.id), item.id).toBe(true);
    for (const item of planned) expect((BUILT as readonly string[]).includes(item.id), item.id).toBe(false);
    // And the product's own list agrees: nothing live is still marked planned there.
    for (const item of CATALOG) expect(item.status.kind === "planned", item.id).toBe(!(BUILT as readonly string[]).includes(item.id));
  });

  it("shows each company's real logo, from a file that exists", () => {
    for (const item of CATALOG) if (!SELESTIAL_OWN.has(item.id)) expect(logoExists(item.id), item.id).toBe(true);
  });

  it("uses the same logos on the home page's integrations section", () => {
    for (const group of HOME.groups) for (const item of group.items) if (!SELESTIAL_OWN.has(item.mark)) expect(logoExists(item.mark), item.name).toBe(true);
  });
});
