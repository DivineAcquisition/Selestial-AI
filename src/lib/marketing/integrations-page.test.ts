import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BUILT } from "../../../convex/lib/integrations";
import { logoFile } from "@/components/app/integration-mark";
import { INTEGRATIONS as CATALOG } from "@/lib/app/integrations";
import { INTEGRATIONS as HOME } from "./content";
import { hubNodes, HUB_IDS } from "@/components/marketing/integration-hub";
import { integrationsByCategory } from "./integrations-page";

// Selestial's own number has no logo of its own. Quo's official mark isn't in the repository yet (its developer terms
// require "Powered by OpenPhone" attribution, and the asset should come from Quo): its card shows a plain glyph until then.
const SELESTIAL_OWN = new Set(["texting-number", "quo"]);
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

  it("draws the home page's hub only from real integrations, each with its logo, live exactly when built", () => {
    const nodes = hubNodes();
    expect(nodes.map((node) => node.id)).toEqual([...HUB_IDS]);
    for (const node of nodes) {
      const item = CATALOG.find((entry) => entry.id === node.id);
      expect(item, node.id).toBeDefined();
      expect(node.name).toBe(item!.name);
      expect(logoExists(node.id), node.id).toBe(true);
      expect(node.live, node.id).toBe((BUILT as readonly string[]).includes(node.id));
    }
    // Each agent on the inner ring sits halfway between two tools' lines, so no line runs through a face.
    expect(HUB_IDS).toHaveLength(10);
    // Field-service platforms are import sources, not tools the agents work in: they stay off the hub.
    expect(nodes.map((node) => node.id)).not.toContain("jobber");
    expect(nodes.map((node) => node.id)).not.toContain("housecall-pro");
    // Quo is on the hub, with Quo's own logo, and live now that it is built.
    expect(nodes.find((node) => node.id === "quo")).toMatchObject({ name: "Quo (formerly OpenPhone)", live: true });
    expect(logoFile("quo")).toBe("quo.png");
  });
});
