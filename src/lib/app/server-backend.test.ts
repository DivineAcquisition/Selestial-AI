import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PRODUCTION_DEPLOYMENTS } from "../../../convex/lib/environment";
import { isLiveBackend, serverBackendUrl } from "./server-backend";

const LIVE = `https://${PRODUCTION_DEPLOYMENTS[0]}.convex.cloud`;
const TEST = "https://terrific-avocet-835.convex.cloud";

describe("the backend a server action may call", () => {
  it("knows the live backend by its name and by its custom domain, and nothing else", () => {
    expect(isLiveBackend(LIVE)).toBe(true);
    expect(isLiveBackend(`${LIVE}/`)).toBe(true);
    expect(isLiveBackend(`https://${PRODUCTION_DEPLOYMENTS[0]}.convex.site`)).toBe(true);
    expect(isLiveBackend("https://api.selestial.io")).toBe(true);
    expect(isLiveBackend(TEST)).toBe(false);
    expect(isLiveBackend("https://example.test")).toBe(false);
    expect(isLiveBackend("not an address")).toBe(false);
  });

  it("refuses the live backend at run time on a preview, though Vercel still supplies its address there", () => {
    expect(serverBackendUrl(LIVE, "preview")).toBeNull();
    expect(serverBackendUrl(LIVE, "development")).toBeNull();
    expect(serverBackendUrl("https://api.selestial.io", "preview")).toBeNull();
    // A preview pointed at the test backend works.
    expect(serverBackendUrl(TEST, "preview")).toBe(TEST);
  });

  it("gives production its address, and a local run whatever it was given", () => {
    expect(serverBackendUrl(LIVE, "production")).toBe(LIVE);
    expect(serverBackendUrl(` ${LIVE} `, "production")).toBe(LIVE);
    expect(serverBackendUrl(TEST, undefined)).toBe(TEST);
    expect(serverBackendUrl(undefined, "production")).toBeNull();
    expect(serverBackendUrl("http://insecure.example.test", "production")).toBeNull();
  });

  it("is what every server action that calls the backend uses", () => {
    for (const file of ["src/app/actions.ts", "src/app/b/actions.ts", "src/app/n/actions.ts", "src/app/trust-actions.ts"]) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source, file).toContain("serverBackendUrl()");
      expect(source, file).not.toContain("process.env.NEXT_PUBLIC_CONVEX_URL");
    }
  });
});
